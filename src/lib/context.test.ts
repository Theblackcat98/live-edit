import { describe, expect, it } from 'vitest'
import type { Directive, ExecutionDiff, Trace, WorkerCall } from '../types'
import { INITIAL_NOTE } from '../data/note'
import { executeTool } from './tools'
import { renderToolCallXml } from './worker'
import { SEED_NOTE_LINE_COUNT, buildD1State, buildWorkerPacket, noteHash, renderUnifiedDiff } from './context'
// The recorded calibration packet (raw text via vite's ?raw loader; the JSON
// is repo data, not src, and this repo has no @types/node for fs imports).
import e3Raw from '../../docs/spikes/E3-d1-check.json?raw'

// --- fixtures ---------------------------------------------------------------------

function makeCall(name: WorkerCall['name'], params: Record<string, string>): WorkerCall {
  return {
    name,
    params,
    thought: 'test call',
    xml: renderToolCallXml(name, params),
    rawTokens: 12,
    promptHints: [],
    toolSchemasInjected: 0,
    noteView: '',
  }
}

/** A completed edit turn on the recorded runs list (Trace), newest-last at `at`. */
function makeEditRun(
  id: string,
  at: number,
  command: string,
  instruction: string,
  tool: WorkerCall['name'],
  diff: ExecutionDiff,
  overrides: Partial<Trace> = {},
): Trace {
  return {
    id,
    at,
    command,
    source: 'text',
    directive: {
      task: 'edit',
      instruction,
      target: { description: 'test target', heading: null },
      verbatim: null,
      constraints: [],
    },
    timings: { route: 1, generate: 1, critic: 1, execute: 1, total: 4 },
    status: 'verified',
    outputTokens: 10,
    promptTokens: 100,
    noteTokensAtStart: 300,
    workerNoteView: '',
    execution: {
      ok: true,
      message: `PROSE-MARKER-MSG ${id}`,
      tool,
      note: 'PROSE-MARKER-NOTE',
      diff,
      durationMs: 1,
    },
    ...overrides,
  }
}

const EDIT_ONE_LINE: ExecutionDiff = {
  startLine: 17,
  before: ['| Q3 | $1.2M | Pending |'],
  after: ['| Q3 | $1.45M | Final |'],
  added: 1,
  removed: 1,
}

// --- buildWorkerPacket ------------------------------------------------------------

describe('buildWorkerPacket', () => {
  const directive: Directive = { task: 'edit', instruction: 'Update the Q3 revenue row.' }

  it('returns zero records and a zero estimate for no runs', () => {
    const packet = buildWorkerPacket(directive, [], INITIAL_NOTE)
    expect(packet.editTurns).toEqual([])
    expect(packet.promptTokens).toBe(0)
  })

  it('maps one completed edit turn to one record', () => {
    const run = makeEditRun('run-1', 1000, 'update the Q3 revenue row to $1.45M Final', 'Update the Q3 revenue row to $1.45M Final.', 'edit_text', EDIT_ONE_LINE)
    const packet = buildWorkerPacket(directive, [run], INITIAL_NOTE)
    expect(packet.editTurns).toHaveLength(1)
    expect(packet.editTurns[0]).toEqual({
      command: 'update the Q3 revenue row to $1.45M Final',
      directiveSummary: 'Update the Q3 revenue row to $1.45M Final.',
      diffSummary: 'edit_text lines 17–17: 1 line replaced',
    })
    expect(packet.promptTokens).toBeGreaterThan(0)
  })

  it('keeps the last 3 of 5 turns, most recent last', () => {
    const runs = [1, 2, 3, 4, 5].map((n) =>
      makeEditRun(`run-${n}`, n * 1000, `cmd-${n}`, `Instruction ${n}.`, 'edit_text', EDIT_ONE_LINE),
    )
    const packet = buildWorkerPacket(directive, runs, INITIAL_NOTE)
    expect(packet.editTurns).toHaveLength(3)
    expect(packet.editTurns.map((turn) => turn.command)).toEqual(['cmd-3', 'cmd-4', 'cmd-5'])
  })

  it('does not depend on the caller list order (recency comes from run timestamps)', () => {
    const runs = [1, 2, 3, 4, 5].map((n) =>
      makeEditRun(`run-${n}`, n * 1000, `cmd-${n}`, `Instruction ${n}.`, 'edit_text', EDIT_ONE_LINE),
    )
    const newestFirst = [...runs].reverse()
    expect(buildWorkerPacket(directive, newestFirst, INITIAL_NOTE)).toEqual(
      buildWorkerPacket(directive, runs, INITIAL_NOTE),
    )
  })

  it('counts only completed edit turns: verified + diff + directive', () => {
    const completed = makeEditRun('ok', 5000, 'cmd-ok', 'Instruction.', 'edit_text', EDIT_ONE_LINE)
    const running = makeEditRun('running', 4000, 'cmd-running', 'Instruction.', 'edit_text', EDIT_ONE_LINE, { status: 'running' })
    const noDiff = makeEditRun('undo-like', 3000, 'cmd-undo', 'Instruction.', 'edit_text', EDIT_ONE_LINE, {
      execution: { ok: true, message: 'Reverted.', tool: 'undo', note: '', durationMs: 1 },
    })
    const noDirective = makeEditRun('legacy', 2000, 'cmd-legacy', 'Instruction.', 'edit_text', EDIT_ONE_LINE, { directive: undefined })
    const rejected = makeEditRun('rejected', 1000, 'cmd-rejected', 'Instruction.', 'edit_text', EDIT_ONE_LINE, { status: 'rejected' })
    const packet = buildWorkerPacket(directive, [completed, running, noDiff, noDirective, rejected], INITIAL_NOTE)
    expect(packet.editTurns).toHaveLength(1)
    expect(packet.editTurns[0].command).toBe('cmd-ok')
  })

  it('excludes assistant prose by construction', () => {
    const run = makeEditRun('run-1', 1000, 'update the Q3 row', 'Update the Q3 revenue row to $1.45M Final.', 'edit_text', EDIT_ONE_LINE, {
      call: makeCall('edit_text', { start_line: '17', end_line: '17', old_text_anchor: 'x', new_text: 'y' }),
    })
    const packet = buildWorkerPacket(directive, [run], INITIAL_NOTE)
    const serialized = JSON.stringify(packet)
    expect(serialized).not.toContain('PROSE-MARKER')
    expect(serialized).toContain('update the Q3 row')
    expect(serialized).toContain('Update the Q3 revenue row to $1.45M Final.')
    expect(serialized).toContain('edit_text lines 17–17: 1 line replaced')
  })

  it('truncates long directives to the documented 200-char budget', () => {
    const longInstruction = 'Expand the executive summary with the full revenue narrative, '.repeat(6)
    const run = makeEditRun('run-1', 1000, 'expand summary', longInstruction, 'edit_text', EDIT_ONE_LINE)
    const packet = buildWorkerPacket(directive, [run], INITIAL_NOTE)
    const summary = packet.editTurns[0].directiveSummary
    expect(summary.length).toBeLessThanOrEqual(200)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.startsWith('Expand the executive summary')).toBe(true)
  })

  it('summarizes every diff kind on one line', () => {
    const multi = makeEditRun('multi', 1000, 'c1', 'i1', 'edit_text', {
      startLine: 5, before: ['a', 'b'], after: ['x', 'y', 'z'], added: 3, removed: 2,
    })
    const removal = makeEditRun('removal', 2000, 'c2', 'i2', 'remove_text', {
      startLine: 7, before: ['- Redis cache migration was postponed to Q4.'], after: [], added: 0, removed: 1,
    })
    const insertion = makeEditRun('insertion', 3000, 'c3', 'i3', 'add_text', {
      startLine: 3, before: [], after: ['- One', '- Two'], added: 2, removed: 0,
    })
    const packet = buildWorkerPacket(directive, [multi, removal, insertion], INITIAL_NOTE)
    expect(packet.editTurns.map((turn) => turn.diffSummary)).toEqual([
      'edit_text lines 5–6: 2 lines replaced with 3 lines',
      'remove_text lines 7–7: 1 line removed',
      'add_text lines 3–4: 2 lines inserted',
    ])
  })

  it('reports the actual post-truncation char/4 token estimate of the packet', () => {
    const runs = [1, 2, 3].map((n) =>
      makeEditRun(`run-${n}`, n * 1000, `command ${n}`, `Instruction ${n}.`, 'edit_text', EDIT_ONE_LINE),
    )
    const packet = buildWorkerPacket(directive, runs, INITIAL_NOTE)
    const packetText = packet.editTurns
      .map((turn) => `${turn.command} | ${turn.directiveSummary} | ${turn.diffSummary}`)
      .join('\n')
    expect(packet.promptTokens).toBe(Math.ceil(packetText.length / 4))
  })
})

// --- buildD1State -----------------------------------------------------------------

const D1_DIRECTIVE: Directive = {
  task: 'edit',
  instruction: 'Update the Q3 revenue row: figure to $1.45M, status to Final.',
  target: { description: 'the Q3 row of the Revenue table', heading: '2. Revenue' },
  verbatim: null,
  constraints: ['keep the table structure'],
}
const D1_COMMAND = 'update the Q3 revenue row to $1.45M Final'
const D1_CALL = {
  name: 'edit_text' as const,
  params: {
    start_line: 33,
    end_line: 33,
    old_text_anchor: '| Q3 | $1.2M | Pending |',
    new_text: '| Q3 | $1.45M | Final |',
  },
}
const D1_DIFF: ExecutionDiff = {
  startLine: 33,
  before: ['| Q3 | $1.2M | Pending |'],
  after: ['| Q3 | $1.45M | Final |'],
  added: 1,
  removed: 1,
}

describe('buildD1State', () => {
  it('assembles the E3 sections in the calibrated order', () => {
    const state = buildD1State({ directive: D1_DIRECTIVE, command: D1_COMMAND, call: D1_CALL, diff: D1_DIFF })
    const lines = state.split('\n')
    // Fixed preamble first, verbatim: d1 judges text only, so the preamble
    // states that none is attached rather than describing an attachment.
    expect(lines[0]).toBe(
      "Safety check for a proposed note edit. You are given the directive from the interface model, the user command, the worker's proposed tool call, and the rendered diff of that call against the current note. No video frame is attached; judge text only.",
    )
    const indexOf = (needle: string) => state.indexOf(needle)
    expect(indexOf('Directive (typed, from the interface model):')).toBeGreaterThan(-1)
    expect(indexOf('User command (verbatim):')).toBeGreaterThan(indexOf('Directive (typed, from the interface model):'))
    expect(indexOf('Proposed tool call (from the worker):')).toBeGreaterThan(indexOf('User command (verbatim):'))
    expect(indexOf('Rendered diff against the current note')).toBeGreaterThan(indexOf('Proposed tool call (from the worker):'))
  })

  it('serializes the directive as indented typed JSON', () => {
    const state = buildD1State({ directive: D1_DIRECTIVE, command: D1_COMMAND, call: D1_CALL, diff: D1_DIFF })
    expect(state).toContain('"task": "edit"')
    expect(state).toContain('"instruction": "Update the Q3 revenue row: figure to $1.45M, status to Final."')
  })

  it('preserves the user command verbatim, exactly as JSON.stringify renders it', () => {
    const tricky = 'change the "Q3" row to 100% — now\n(both cells, please)'
    const state = buildD1State({ directive: D1_DIRECTIVE, command: tricky, call: D1_CALL, diff: D1_DIFF })
    expect(state).toContain(`User command (verbatim): ${JSON.stringify(tricky)}`)
    expect(state).not.toContain(`User command (verbatim): ${JSON.stringify(tricky.slice(0, 20))}…`)
  })

  it('serializes the proposed call as {name, arguments} JSON and the diff below its label', () => {
    const state = buildD1State({ directive: D1_DIRECTIVE, command: D1_COMMAND, call: D1_CALL, diff: D1_DIFF })
    expect(state).toContain('"name": "edit_text"')
    expect(state).toContain('"arguments": {')
    expect(state).toContain('@@ lines 33-33 replaced @@')
    expect(state).toContain('- | Q3 | $1.2M | Pending |')
    expect(state).toContain('+ | Q3 | $1.45M | Final |')
    expect(state.indexOf('- | Q3 | $1.2M | Pending |')).toBeGreaterThan(
      state.indexOf('Rendered diff against the current note'),
    )
  })

  it('uses the E3 seed-note defaults in the diff label', () => {
    const state = buildD1State({ directive: D1_DIRECTIVE, command: D1_COMMAND, call: D1_CALL, diff: D1_DIFF })
    expect(state).toContain('Rendered diff against the current note (notes/quarterly-review.md, 42 content lines):')
    expect(SEED_NOTE_LINE_COUNT).toBe(42)
  })

  it('accepts the rendered-against note path and line count from the caller', () => {
    const state = buildD1State({
      directive: D1_DIRECTIVE,
      command: D1_COMMAND,
      call: D1_CALL,
      diff: D1_DIFF,
      notePath: 'notes/other.md',
      noteLineCount: 80,
    })
    expect(state).toContain('Rendered diff against the current note (notes/other.md, 80 content lines):')
  })

  it('includes the last user turn iff present, between the command and the call', () => {
    const base = { directive: D1_DIRECTIVE, command: D1_COMMAND, call: D1_CALL, diff: D1_DIFF }
    const without = buildD1State(base)
    expect(without).not.toContain('Last user turn (context)')
    const withTurn = buildD1State({ ...base, lastUserTurn: 'update the Q2 revenue row too' })
    expect(withTurn).toContain(`Last user turn (context): ${JSON.stringify('update the Q2 revenue row too')}`)
    const indexOf = (needle: string) => withTurn.indexOf(needle)
    expect(indexOf('Last user turn (context)')).toBeGreaterThan(indexOf('User command (verbatim)'))
    expect(indexOf('Last user turn (context)')).toBeLessThan(indexOf('Proposed tool call (from the worker)'))
    // The E3 sections keep their exact relative order either way.
    expect(without.split('Proposed tool call (from the worker):')[1]).toBe(
      withTurn.split('Proposed tool call (from the worker):')[1],
    )
  })

  it('bounds the optional last user turn to the documented budget', () => {
    const longTurn = 'a very long previous command '.repeat(60)
    const state = buildD1State({
      directive: D1_DIRECTIVE,
      command: D1_COMMAND,
      call: D1_CALL,
      diff: D1_DIFF,
      lastUserTurn: longTurn,
    })
    const line = state.split('\n').find((entry) => entry.startsWith('Last user turn (context)'))
    const rendered = JSON.parse(line!.slice('Last user turn (context): '.length)) as string
    expect(rendered.length).toBeLessThanOrEqual(600)
    expect(rendered.endsWith('…')).toBe(true)
  })

  it('never embeds binary attachment data in the state blob', () => {
    const state = buildD1State({ directive: D1_DIRECTIVE, command: D1_COMMAND, call: D1_CALL, diff: D1_DIFF })
    expect(state).not.toContain('data:image')
  })

  it('truncates a pathological diff to the documented 200-line budget', () => {
    const huge: ExecutionDiff = {
      startLine: 1,
      before: Array.from({ length: 250 }, (_, n) => `old line ${n + 1}`),
      after: [],
      added: 0,
      removed: 250,
    }
    const call = { name: 'remove_text' as const, params: { start_line: 1, end_line: 250, target_excerpt: 'everything' } }
    const state = buildD1State({ directive: D1_DIRECTIVE, command: D1_COMMAND, call, diff: huge })
    expect(state).toContain('… (diff truncated to the first 200 of 251 lines)')
    // The cap counts the header line too, so 199 of the 250 removed lines show.
    expect(state.split('\n').filter((line) => line.startsWith('- old line')).length).toBe(199)
  })
})

// --- renderUnifiedDiff ------------------------------------------------------------

describe('renderUnifiedDiff', () => {
  it('renders a multi-line replacement as - before then + after under one header', () => {
    const diff: ExecutionDiff = {
      startLine: 5,
      before: ['first old line', 'second old line'],
      after: ['new line one', 'new line two', 'new line three'],
      added: 3,
      removed: 2,
    }
    expect(renderUnifiedDiff(diff)).toBe(
      [
        '@@ lines 5-6 replaced @@',
        '- first old line',
        '- second old line',
        '+ new line one',
        '+ new line two',
        '+ new line three',
      ].join('\n'),
    )
  })

  it('renders a pure removal with no + lines', () => {
    const diff: ExecutionDiff = {
      startLine: 25,
      before: ['- Redis cache migration was postponed to Q4.'],
      after: [],
      added: 0,
      removed: 1,
    }
    const rendered = renderUnifiedDiff(diff)
    expect(rendered).toBe(
      ['@@ lines 25-25 removed (1 lines) @@', '- - Redis cache migration was postponed to Q4.'].join('\n'),
    )
    expect(rendered.split('\n').filter((line) => line.startsWith('+ ')).length).toBe(0)
  })

  it('renders a pure insertion and an empty diff', () => {
    const diff: ExecutionDiff = { startLine: 3, before: [], after: ['- One'], added: 1, removed: 0 }
    expect(renderUnifiedDiff(diff)).toBe('@@ insert at line 3 (1 line) @@\n+ - One')
    expect(renderUnifiedDiff({ startLine: 1, before: [], after: [], added: 0, removed: 0 })).toBe('')
  })
})

// --- E3 fidelity: byte-identity with the recorded calibration packet --------------

/**
 * The d1 thresholds (noul ≥ 0.50 AND destructive_safety = safe) were
 * calibrated against the exact state text recorded in
 * docs/spikes/E3-d1-check.json. These tests re-assemble one fixture per diff
 * kind (edit, remove, insert-under-heading, prepend) and require
 * BYTE-IDENTICAL output — the packet must stay fixed for the calibration to
 * hold. Diffs are real: produced by executeTool on the seed note, exactly as
 * the pipeline produces them.
 */
describe('buildD1State — E3 recorded-state fidelity', () => {
  const spike = JSON.parse(e3Raw) as {
    fixtures: Array<{
      id: string
      command: string
      directive: Directive
      call: { name: WorkerCall['name']; arguments: Record<string, unknown> }
      state: string
    }>
  }

  const FIDELITY_IDS = [
    'g01-q3-revenue-edit',
    'g02-remove-redis-bullet',
    'g03-add-security-line',
    'g10-readme-prepend',
  ]

  it.each(FIDELITY_IDS)('reproduces the recorded state byte-for-byte: %s', (id) => {
    const fixture = spike.fixtures.find((entry) => entry.id === id)
    expect(fixture, `fixture ${id} missing from the recorded spike JSON`).toBeTruthy()
    const params = Object.fromEntries(
      Object.entries(fixture!.call.arguments).map(([key, value]) => [key, String(value)]),
    )
    const execution = executeTool(INITIAL_NOTE, makeCall(fixture!.call.name, params))
    expect(execution.ok, `executeTool fixture ${id}: ${execution.message}`).toBe(true)
    expect(execution.diff).toBeTruthy()
    const state = buildD1State({
      directive: fixture!.directive,
      command: fixture!.command,
      // The recorded arguments pass through verbatim (numeric line values and
      // all), exactly as the spike serialized them.
      call: { name: fixture!.call.name, params: fixture!.call.arguments },
      diff: execution.diff!,
    })
    expect(state).toBe(fixture!.state)
  })
})

// --- noteHash ----------------------------------------------------------------------

describe('noteHash', () => {
  it('is deterministic across calls (no Math.random, no Date)', () => {
    expect(noteHash(INITIAL_NOTE)).toBe(noteHash(INITIAL_NOTE))
    expect(noteHash('some note')).toBe(noteHash('some note'))
  })

  it('changes on a single content-character change', () => {
    const base = 'The Q3 figure is waiting on the final enterprise invoice reconciliation.'
    const changed = 'The Q4 figure is waiting on the final enterprise invoice reconciliation.'
    expect(noteHash(base)).not.toBe(noteHash(changed))
  })

  it('is stable under the documented whitespace normalizations', () => {
    // Documented: CRLF/CR → LF, per-line leading/trailing whitespace stripped,
    // leading/trailing blank lines dropped. Internal whitespace and internal
    // blank lines remain significant (they shift line numbers — staleness).
    const note = 'line one\nline two\n\nline three\n'
    expect(noteHash(note)).toBe(noteHash('  line one\t\n\tline two\n\nline three  '))
    expect(noteHash(note)).toBe(noteHash(note.replace(/\n/g, '\r\n')))
    expect(noteHash(note)).toBe(noteHash(`\n\n${note}`))
    expect(noteHash('a  b')).not.toBe(noteHash('a b'))
    expect(noteHash('a\n\nb')).not.toBe(noteHash('a\nb'))
    expect(noteHash('')).toBe(noteHash('\n\n  \n'))
  })

  it('returns a fixed-width hex string that separates different notes', () => {
    const hash = noteHash(INITIAL_NOTE)
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
    expect(hash).not.toBe(noteHash(`${INITIAL_NOTE}appendix\n`))
  })
})
