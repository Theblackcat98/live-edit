/**
 * buildOmniHistory (design.md §6): Omni's history is assembled from the
 * transcript plus recorded runs — answer turns contribute their visible
 * reply, delegation turns contribute the recorded directive as a tool
 * record. Harness prose (error bubbles, completion boilerplate after a
 * delegation) must never leak in as model-authored history.
 */
import { describe, expect, it } from 'vitest'
import type { Message, Trace } from '../types'
import { buildOmniHistory } from './pipeline'

let seq = 0
function msg(partial: Partial<Message>): Message {
  seq += 1
  return {
    id: `m${seq}`,
    at: seq,
    role: 'user',
    text: '',
    ...partial,
  } as Message
}

function run(partial: Partial<Trace>): Trace {
  return {
    id: 'run-1',
    at: 1,
    command: 'cmd',
    source: 'text',
    status: 'verified',
    outputTokens: 0,
    promptTokens: 0,
    noteTokensAtStart: 0,
    workerNoteView: '',
    timings: { route: 0, ground: 0, generate: 0, critic: 0, execute: 0, total: 0 },
    ...partial,
  } as Trace
}

describe('buildOmniHistory', () => {
  it('pairs commands with their visible replies', () => {
    const history = buildOmniHistory(
      [
        msg({ role: 'user', text: 'what is in the note?' }),
        msg({ role: 'assistant', text: 'Three sections.' }),
        msg({ role: 'user', text: 'thanks' }),
      ],
      [],
    )
    expect(history).toEqual([
      { command: 'what is in the note?', reply: 'Three sections.' },
      { command: 'thanks' },
    ])
  })

  it('records delegations as tool records, not prose', () => {
    const directive = { task: 'insert' as const, instruction: 'add the Q4 dates' }
    const history = buildOmniHistory(
      [
        msg({ role: 'user', text: 'add the Q4 dates' }),
        msg({
          role: 'tool',
          text: '',
          runId: 'run-1',
          delegation: { runId: 'run-1', tool: 'add_text', status: 'executed', modelLabel: '1.7B' },
        }),
        msg({ role: 'assistant', text: 'Inserted 2 lines after line 9.', runId: 'run-1', kind: 'result' }),
      ],
      [run({ id: 'run-1', directive, status: 'verified' })],
    )
    expect(history).toHaveLength(1)
    expect(history[0].delegation).toEqual({
      tool: 'delegate_edit',
      arguments: JSON.stringify(directive),
      result: 'Executed',
    })
    expect(history[0].reply).toBeUndefined()
  })

  it('marks failed delegations and skips error bubbles', () => {
    const history = buildOmniHistory(
      [
        msg({ role: 'user', text: 'remove the risks' }),
        msg({
          role: 'tool',
          text: '',
          runId: 'run-9',
          delegation: { runId: 'run-9', tool: 'remove_text', status: 'rejected', modelLabel: '1.7B' },
        }),
        msg({ role: 'assistant', text: 'I stopped the run: boom', kind: 'error' }),
        msg({ role: 'user', text: 'what happened?' }),
        msg({ role: 'assistant', text: 'The safety check refused it.', kind: 'error' }),
      ],
      [run({ id: 'run-9', directive: { task: 'remove' as const, instruction: 'remove risks' }, status: 'rejected' })],
    )
    expect(history[0].delegation?.result).toBe('Execution failed')
    expect(history[0].reply).toBeUndefined()
    expect(history[1]).toEqual({ command: 'what happened?' })
  })
})
