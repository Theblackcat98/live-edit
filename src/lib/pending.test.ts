import { describe, expect, it } from 'vitest'
import type { Directive, ExecutionDiff, PendingEdit, WorkerCall } from '../types'
import { renderToolCallXml } from './worker'
import { adjudicate, createPendingEdit, enqueue, fromStorable, toStorable } from './pending'

/**
 * Tests for the pending-edit store (design.md §9): creation, adjudication
 * (applied / stale / discarded), the FIFO queue, and the D3 persistence
 * shape. All pure — the staleness case mutates the note the edit was
 * authored against and asserts the anchor-exactness gate fails for real
 * (no mocks of runHardGates; the store genuinely re-runs it).
 */

/** Deterministic test hash (FNV-1a) — stands in for the real note hash the wiring injects. */
function noteHash(note: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < note.length; index += 1) {
    hash ^= note.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function makeDirective(instruction: string): Directive {
  return {
    task: 'edit',
    instruction,
    target: { description: 'the Redis cache line under Risks', heading: 'Risks' },
    verbatim: null,
    constraints: ['keep the section structure'],
  }
}

function makeCall(params: Record<string, string>): WorkerCall {
  return {
    name: 'edit_text',
    params,
    thought: 'update the redis line',
    xml: renderToolCallXml('edit_text', params),
    rawTokens: 48,
    promptHints: [],
    toolSchemasInjected: 4,
    noteView: '',
  }
}

/** Line 5 of NOTE is the target: the anchor gate checks the note's own line at that range. */
const NOTE = [
  '# Meeting notes',
  '',
  '## Risks',
  'The migration window is tight.',
  'Redis cache is on the critical path.',
  '',
  '## Next steps',
  'Circulate the summary by Friday.',
  '',
].join('\n')

const MUTATED_NOTE = NOTE.replace(
  'Redis cache is on the critical path.',
  'Redis cache migration slipped to Q4.',
)

const CALL = makeCall({
  file_path: 'notes/meeting.md',
  start_line: '5',
  end_line: '5',
  old_text_anchor: 'Redis cache is on the critical path.',
  new_text: 'The Redis cache work is unblocked.',
})

const DIFF: ExecutionDiff = {
  startLine: 5,
  before: ['Redis cache is on the critical path.'],
  after: ['The Redis cache work is unblocked.'],
  added: 1,
  removed: 1,
}

const D1 = {
  verdict: 'disapproved' as const,
  noul: 0.31,
  destructiveSafety: 'safe' as const,
  reason: 'noul below threshold',
}

function makePendingEdit(instruction = 'Fix the Redis cache line', call: WorkerCall = CALL): PendingEdit {
  return createPendingEdit({
    directive: makeDirective(instruction),
    call,
    diff: DIFF,
    noteHash: noteHash(NOTE),
    d1: D1,
  })
}

const ADD_CALL: WorkerCall = {
  name: 'add_text',
  params: {
    file_path: 'notes/meeting.md',
    position: 'under_heading',
    anchor: 'Risks',
    content: '- New risk line',
  },
  thought: 'add a risk bullet',
  xml: renderToolCallXml('add_text', {
    file_path: 'notes/meeting.md',
    position: 'under_heading',
    anchor: 'Risks',
    content: '- New risk line',
  }),
  rawTokens: 32,
  promptHints: [],
  toolSchemasInjected: 4,
  noteView: '',
}

const ADD_DIFF: ExecutionDiff = {
  startLine: 4,
  before: [],
  after: ['- New risk line'],
  added: 1,
  removed: 0,
}

/** The authoring note's lines either side of ADD_DIFF's insertion point (line 4). */
const INSERTION = {
  startLine: 4,
  precedingLine: '## Risks',
  followingLine: 'The migration window is tight.',
}

function makeAddPendingEdit(): PendingEdit {
  return createPendingEdit({
    directive: makeDirective('Add a risk bullet'),
    call: ADD_CALL,
    diff: ADD_DIFF,
    noteHash: noteHash(NOTE),
    d1: D1,
    insertion: INSERTION,
  })
}

// --- createPendingEdit ------------------------------------------------------------

describe('createPendingEdit', () => {
  it('builds the PendingEdit shape: pending status, epoch-ms createdAt, echoed proposal fields', () => {
    const before = Date.now()
    const edit = makePendingEdit()
    expect(edit.status).toBe('pending')
    expect(edit.createdAt).toBeGreaterThanOrEqual(before)
    expect(edit.createdAt).toBeLessThanOrEqual(Date.now())
    expect(edit.directive.instruction).toBe('Fix the Redis cache line')
    expect(edit.call).toBe(CALL)
    expect(edit.diff).toBe(DIFF)
    expect(edit.noteHash).toBe(noteHash(NOTE))
    expect(edit.d1).toEqual(D1)
    expect(edit.id).toMatch(/^pending-/)
  })

  it('ids are unique per creation even in the same millisecond (module counter, no Math.random)', () => {
    const first = makePendingEdit()
    const second = makePendingEdit()
    expect(first.id).not.toBe(second.id)
  })
})

// --- adjudicate -------------------------------------------------------------------

describe('adjudicate', () => {
  it('apply with a clean note resolves applied and returns the call for the caller to execute', () => {
    const edit = makePendingEdit()
    const result = adjudicate(edit, 'apply', NOTE, { noteHash })
    expect(result.status).toBe('applied')
    expect(result.call).toBe(edit.call)
    expect(result.edit.status).toBe('applied')
    expect(result.reason).toContain('executeTool')
    // Purity: the queued entry is replaced by the result's edit, not mutated.
    expect(edit.status).toBe('pending')
  })

  it('apply after the target lines changed resolves stale: names the gate, explains the drift, returns no call', () => {
    // Real drift: the edit was authored against NOTE; the target line was
    // edited while the proposal sat pending, so the anchor gate must fail
    // when the hard gates re-run against MUTATED_NOTE.
    const edit = makePendingEdit()
    const result = adjudicate(edit, 'apply', MUTATED_NOTE, { noteHash })
    expect(result.status).toBe('stale')
    expect(result.call).toBeUndefined()
    expect(result.edit.status).toBe('stale')
    expect(edit.status).toBe('pending')
    // design.md §8: the reason names which gate failed and says the text changed.
    expect(result.reason).toContain('anchor_exact')
    expect(result.reason).toContain('The note changed since the edit was authored')
    expect(result.reason).toContain('the text this edit was written against has changed')
    expect(result.reason).toContain('Nothing was written')
  })

  it('a gate failure with an unchanged note hash still resolves stale but never claims drift', () => {
    // The call guts its own target (blast-radius gate) and the note is
    // byte-identical to the authoring note — the store must report the gate
    // failure without inventing a drift it cannot show.
    const gutting = makeCall({
      file_path: 'notes/meeting.md',
      start_line: '5',
      end_line: '5',
      old_text_anchor: 'Redis cache is on the critical path.',
      new_text: 'no',
    })
    const edit = makePendingEdit('Gut the redis line', gutting)
    const result = adjudicate(edit, 'apply', NOTE, { noteHash })
    expect(result.status).toBe('stale')
    expect(result.call).toBeUndefined()
    expect(result.reason).toContain('blast_radius')
    expect(result.reason).toContain('gate-rule failure')
    expect(result.reason).not.toContain('has changed')
  })

  it('discard resolves discarded, writes nothing, and points the caller at the rejected-traces log', () => {
    const edit = makePendingEdit()
    const result = adjudicate(edit, 'discard', NOTE, { noteHash })
    expect(result.status).toBe('discarded')
    expect(result.call).toBeUndefined()
    expect(result.edit.status).toBe('discarded')
    expect(result.reason).toContain('rejected-traces')
    expect(edit.status).toBe('pending')
  })

  it('insertion pending: carries the recorded neighbourhood from creation', () => {
    const edit = makeAddPendingEdit()
    expect(edit.insertion).toEqual(INSERTION)
    expect(makePendingEdit().insertion).toBeUndefined()
  })

  it('insertion pending: ✓ on the untouched note applies (gates are vacuous, context intact)', () => {
    const result = adjudicate(makeAddPendingEdit(), 'apply', NOTE, { noteHash })
    expect(result.status).toBe('applied')
    expect(result.call?.name).toBe('add_text')
  })

  it('insertion pending: ✓ after the following line was hand-edited resolves stale (case 33)', () => {
    const drifted = NOTE.replace(
      'The migration window is tight.',
      'The migration window is tight. (hand-revised)',
    )
    const result = adjudicate(makeAddPendingEdit(), 'apply', drifted, { noteHash })
    expect(result.status).toBe('stale')
    expect(result.call).toBeUndefined()
    expect(result.reason).toContain('insertion point (line 4)')
    expect(result.reason).toContain('Nothing was written')
  })

  it('insertion pending: the neighbourhood survives the persistence round-trip', () => {
    const edit = makeAddPendingEdit()
    const [restored] = fromStorable(JSON.parse(JSON.stringify(toStorable([edit]))))
    expect(restored?.insertion).toEqual(INSERTION)
  })
})

// --- enqueue (FIFO, design.md §9: a new turn never clears the queue) --------------

describe('enqueue', () => {
  it('appends in arrival order and never mutates the existing queue', () => {
    const first = makePendingEdit('first')
    const second = makePendingEdit('second')
    const third = makePendingEdit('third')
    const empty: PendingEdit[] = []
    const queueOne = enqueue(empty, first)
    const queueTwo = enqueue(queueOne, second)
    const queueThree = enqueue(queueTwo, third)
    expect(queueThree.map((edit) => edit.directive.instruction)).toEqual(['first', 'second', 'third'])
    expect(empty).toEqual([])
    expect(queueOne).toHaveLength(1)
    expect(queueTwo).toHaveLength(2)
    expect(queueThree).not.toBe(queueTwo)
  })
})

// --- toStorable (D3: the 10 most recent non-resolved; resolved ones dropped) ------

describe('toStorable', () => {
  it('caps at the 10 most recent pending entries and drops resolved ones (applied, discarded, stale)', () => {
    const edits: PendingEdit[] = []
    for (let index = 0; index < 12; index += 1) {
      edits.push(makePendingEdit(`edit ${index}`))
    }
    // Resolve three mid-queue entries three different ways.
    edits[1] = adjudicate(edits[1], 'discard', NOTE, { noteHash }).edit
    edits[4] = adjudicate(edits[4], 'apply', NOTE, { noteHash }).edit
    edits[7] = adjudicate(edits[7], 'apply', MUTATED_NOTE, { noteHash }).edit
    const stored = toStorable(edits)
    expect(stored).toHaveLength(9)
    expect(stored.every((edit) => edit.status === 'pending')).toBe(true)
    const storedIds = new Set(stored.map((edit) => edit.id))
    expect(storedIds.has(edits[1].id)).toBe(false)
    expect(storedIds.has(edits[4].id)).toBe(false)
    expect(storedIds.has(edits[7].id)).toBe(false)
    // FIFO order preserved among the survivors.
    expect(stored.map((edit) => edit.directive.instruction)).toEqual(
      ['edit 0', 'edit 2', 'edit 3', 'edit 5', 'edit 6', 'edit 8', 'edit 9', 'edit 10', 'edit 11'],
    )
  })

  it('keeps only the newest 10 when everything is still pending', () => {
    const edits: PendingEdit[] = []
    for (let index = 0; index < 12; index += 1) {
      edits.push(makePendingEdit(`edit ${index}`))
    }
    const stored = toStorable(edits)
    expect(stored).toHaveLength(10)
    expect(stored[0].directive.instruction).toBe('edit 2')
    expect(stored[9].directive.instruction).toBe('edit 11')
  })
})

// --- fromStorable (D3 reload: defensive, never throws, drops junk) ---------------

describe('fromStorable', () => {
  it('round-trips what toStorable persisted, id included (QA 34: reload restores the card)', () => {
    const edits = [makePendingEdit('one'), makePendingEdit('two')]
    const stored = toStorable(edits)
    expect(fromStorable(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
  })

  it('parses a valid array entry-by-entry', () => {
    const edit = makePendingEdit()
    const results = fromStorable([
      {
        id: edit.id,
        createdAt: edit.createdAt,
        directive: edit.directive,
        call: edit.call,
        diff: edit.diff,
        noteHash: edit.noteHash,
        d1: edit.d1,
        status: 'pending',
      },
    ])
    expect(results).toEqual([edit])
  })

  it('drops malformed entries instead of throwing: junk shapes, bad statuses, broken sub-objects', () => {
    const good = makePendingEdit('survivor')
    const goodPayload = {
      id: good.id,
      createdAt: good.createdAt,
      directive: good.directive,
      call: good.call,
      diff: good.diff,
      noteHash: good.noteHash,
      d1: good.d1,
      status: 'pending',
    }
    const results = fromStorable([
      null,
      42,
      'pending edit',
      {},
      { id: 'missing-everything' },
      { ...goodPayload, status: 'applied' }, // resolved entries are never persisted; stale schema data
      { ...goodPayload, call: { ...good.call, name: 'rm_rf' } }, // unknown tool
      { ...goodPayload, directive: { ...good.directive, task: 'destroy' } }, // task outside the union
      { ...goodPayload, noteHash: '' }, // empty hash
      { ...goodPayload, createdAt: Number.NaN },
      { ...goodPayload, diff: { ...good.diff, before: 'not-an-array' } },
      { ...goodPayload, d1: { ...good.d1, verdict: 'maybe' } }, // unknown verdict
      goodPayload,
    ])
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(good.id)
    expect(results[0].directive.instruction).toBe('survivor')
  })

  it('round-trips a §8 blast-radius hold record (d1 verdict approved)', () => {
    const edit = makePendingEdit('held')
    const stored = toStorable([{ ...edit, d1: { ...edit.d1, verdict: 'approved' as const } }])
    const results = fromStorable(JSON.parse(JSON.stringify(stored)))
    expect(results).toHaveLength(1)
    expect(results[0].d1.verdict).toBe('approved')
  })

  it('never throws on non-array input and returns an empty queue for an empty array', () => {
    expect(fromStorable(undefined)).toEqual([])
    expect(fromStorable(null)).toEqual([])
    expect(fromStorable({})).toEqual([])
    expect(fromStorable('nope')).toEqual([])
    expect(fromStorable([])).toEqual([])
  })
})

describe('blast-radius override adjudication', () => {
  const gutting = makeCall({
    file_path: 'notes/meeting.md',
    start_line: '5',
    end_line: '5',
    old_text_anchor: 'Redis cache is on the critical path.',
    new_text: 'no',
  })

  function overrideEdit(): PendingEdit {
    return createPendingEdit({
      directive: makeDirective('Gut the redis line'),
      call: gutting,
      diff: DIFF,
      noteHash: noteHash(NOTE),
      d1: D1,
      overrideBlastRadius: true,
    })
  }

  it('waives the destructiveness cap on approval but never a correctness gate', () => {
    const applied = adjudicate(overrideEdit(), 'apply', NOTE, { noteHash })
    expect(applied.status).toBe('applied')
    expect(applied.call).toBe(gutting)
    expect(applied.reason).toContain('waived')
    // The anchor gate is a correctness check: drift still refuses the apply.
    const drifted = adjudicate(overrideEdit(), 'apply', MUTATED_NOTE, { noteHash })
    expect(drifted.status).toBe('stale')
    expect(drifted.call).toBeUndefined()
    expect(drifted.reason).toContain('anchor_exact')
  })

  it('round-trips the override flag through storage', () => {
    const restored = fromStorable(
      JSON.parse(JSON.stringify(toStorable([overrideEdit()]))) as unknown,
    )
    expect(restored).toHaveLength(1)
    expect(restored[0]?.overrideBlastRadius).toBe(true)
    expect(restored[0]?.call.params.new_text).toBe('no')
  })
})

// --- run linkage and full d1 scores survive a reload ---------------------------

describe('pending edits keep their run and every d1 score across a reload', () => {
  it('round-trips runId, holdKind and the advisory scores', () => {
    const edit = createPendingEdit({
      directive: makeDirective('Fix the Redis cache line'),
      call: CALL,
      diff: DIFF,
      noteHash: noteHash(NOTE),
      d1: { ...D1, intentClarity: 0.72, targetSupport: 'supported', executionConfidence: 0.44 },
      runId: 'run_abc',
      holdKind: 'd1',
    })
    const [restored] = fromStorable(JSON.parse(JSON.stringify(toStorable([edit]))))
    expect(restored.runId).toBe('run_abc')
    expect(restored.holdKind).toBe('d1')
    expect(restored.d1.intentClarity).toBe(0.72)
    expect(restored.d1.targetSupport).toBe('supported')
    expect(restored.d1.executionConfidence).toBe(0.44)
  })

  it('drops an unknown holdKind instead of trusting it', () => {
    const edit = { ...makePendingEdit(), holdKind: 'made-up' } as unknown as PendingEdit
    const [restored] = fromStorable(JSON.parse(JSON.stringify([edit])))
    expect(restored.holdKind).toBeUndefined()
  })
})
