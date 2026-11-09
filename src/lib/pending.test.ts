import { describe, expect, it } from 'vitest'
import type { WorkerCall } from '../types'
import { NOTE_PATH } from '../data/note'
import { noteHash, splitLines } from './doc'
import {
  applyPendingEdit,
  createPendingEdit,
  directiveFromCommand,
  isPendableRejection,
  pendingToRejectedRecord,
  unresolvedPendings,
} from './pending'
import { renderToolCallXml } from './worker'

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

const NOTE = [
  '# Launch notes',
  '',
  'First body line.',
  'Second body line.',
  'Third body line.',
  '',
  '## Risks',
  '',
  'Supply chain delays.',
].join('\n')

function editCall(): WorkerCall {
  return makeCall('edit_text', {
    file_path: NOTE_PATH,
    start_line: '9',
    end_line: '9',
    old_text_anchor: 'Supply chain delays.',
    new_text: 'Supply chain delays are resolved.',
  })
}

function propose() {
  const pending = createPendingEdit(NOTE, {
    command: 'update the risk line',
    call: editCall(),
    d1: { verdict: 'disapproved', noul: 0.31, destructiveSafety: 'safe', reason: 'semantic mismatch' },
  })
  if (!pending) throw new Error('expected a pending edit')
  return pending
}

describe('directiveFromCommand', () => {
  it('maps tools to task classes and keeps the command as the brief', () => {
    expect(directiveFromCommand('add a line', makeCall('add_text', {})).task).toBe('insert')
    expect(directiveFromCommand('drop it', makeCall('remove_text', {})).task).toBe('remove')
    expect(directiveFromCommand('pull that region', makeCall('extract_visual_to_note', {})).task).toBe('extract')
    expect(directiveFromCommand('fix it', editCall()).instruction).toBe('fix it')
  })
})

describe('isPendableRejection', () => {
  it('is true when only semantic grounds remain (all hard gates pass)', () => {
    expect(isPendableRejection(NOTE, editCall())).toBe(true)
  })

  it('is false when a hard gate fails (stale anchor) — never adjudicable', () => {
    const stale = makeCall('edit_text', {
      file_path: NOTE_PATH,
      start_line: '9',
      end_line: '9',
      old_text_anchor: 'No such line exists.',
      new_text: 'Replacement.',
    })
    expect(isPendableRejection(NOTE, stale)).toBe(false)
  })

  it('is false for a blast-radius violation (deleting the whole note)', () => {
    const wipe = makeCall('remove_text', {
      file_path: NOTE_PATH,
      start_line: '1',
      end_line: '9',
      target_excerpt: 'everything',
    })
    expect(isPendableRejection(NOTE, wipe)).toBe(false)
  })
})

describe('createPendingEdit', () => {
  it('renders the diff against the authored note and records its hash', () => {
    const pending = propose()
    expect(pending.status).toBe('pending')
    expect(pending.noteHash).toBe(noteHash(NOTE))
    expect(pending.diff.after).toEqual(['Supply chain delays are resolved.'])
    expect(pending.d1.noul).toBe(0.31)
    expect(splitLines(NOTE)[8]).toBe('Supply chain delays.')
  })
})

describe('applyPendingEdit', () => {
  it('applies when the note is untouched and gates still pass', () => {
    const outcome = applyPendingEdit(NOTE, propose())
    expect(outcome.kind).toBe('applied')
    if (outcome.kind === 'applied') {
      expect(outcome.execution.note).toContain('Supply chain delays are resolved.')
    }
  })

  it('resolves as stale when the note drifted after proposal', () => {
    const outcome = applyPendingEdit(`${NOTE}\nA new line.`, propose())
    expect(outcome.kind).toBe('stale')
  })

  it('never force-applies a call whose anchors no longer match', () => {
    const pending = propose()
    const drifted = NOTE.replace('Supply chain delays.', 'Totally different line.')
    const outcome = applyPendingEdit(drifted, pending)
    expect(outcome.kind).toBe('stale')
  })
})

describe('pendingToRejectedRecord', () => {
  it('marks adjudication provenance honestly', () => {
    const record = pendingToRejectedRecord(propose(), 'Discarded by the user at adjudication.')
    expect(record.grounding.source).toBe('pending-adjudication')
    expect(record.critic.verdict).toBe('rejected')
    expect(record.critic.pCorrect).toBe(0.31)
    expect(record.command).toBe('update the risk line')
  })
})

describe('unresolvedPendings', () => {
  it('returns only status pending, oldest first', () => {
    const pending = propose()
    const applied = { ...propose(), status: 'applied' as const }
    expect(unresolvedPendings([applied, pending])).toEqual([pending])
  })
})
