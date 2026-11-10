import { describe, expect, it } from 'vitest'
import type { PendingEdit } from '../types'
import { pendingResolutionRecord } from './useWorkspace'

/**
 * The §9.5 rejected-traces record for a resolved pending edit (battery
 * case 32): the record must carry the proposal — directive, call, and the
 * d1 verdict that routed the edit to adjudication.
 */
const EDIT: PendingEdit = {
  id: 'pending-test-1',
  createdAt: 1700000000000,
  directive: {
    task: 'edit',
    instruction: 'Replace the Risks section with tiny',
    target: { description: 'the Risks section', heading: 'Risks' },
    verbatim: null,
    constraints: [],
    frame_relevant: false,
  },
  call: {
    name: 'edit_text',
    params: { file_path: 'notes/meeting.md', start_line: '3', end_line: '6' },
    thought: 'replace the section',
    xml: '<tool_call></tool_call>',
    rawTokens: 40,
    promptHints: [],
    toolSchemasInjected: 4,
    noteView: '',
  },
  diff: { startLine: 3, before: ['## Risks'], after: ['tiny'], added: 1, removed: 4 },
  noteHash: 'abc123',
  d1: {
    verdict: 'disapproved',
    noul: 0.22,
    destructiveSafety: 'unintended_data_loss',
    reason: 'destructive_safety failed',
  },
  status: 'discarded',
}

describe('pendingResolutionRecord', () => {
  it('carries the d1 verdict that routed the edit to adjudication (case 32)', () => {
    const record = pendingResolutionRecord(EDIT, 'Discarded by the user at adjudication (design.md §9).')
    expect(record.d1).toEqual(EDIT.d1)
    expect(record.directive).toEqual(EDIT.directive)
    expect(record.route.tool).toBe('edit_text')
    expect(record.critic.verdict).toBe('rejected')
    expect(record.critic.pCorrect).toBe(0.22)
  })
})
