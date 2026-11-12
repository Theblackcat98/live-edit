/**
 * buildOmniHistory (design.md §6): Omni's history is assembled from the
 * transcript plus recorded runs — answer turns contribute their visible
 * reply, delegation turns contribute the recorded directive as a tool
 * record. Harness prose (error bubbles, completion boilerplate after a
 * delegation) must never leak in as model-authored history.
 */
import { describe, expect, it } from 'vitest'
import type { Directive, Message, Trace } from '../types'
import { buildDictationCall, buildOmniHistory } from './pipeline'

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
    timings: { route: 0, generate: 0, critic: 0, execute: 0, total: 0 },
    ...partial,
  } as Trace
}

describe('buildDictationCall (design.md §11 dictation exception)', () => {
  const note = '# Note\n\n## Reminders\n\n- Old item\n'

  it('builds an under_heading add_text with the verbatim text untouched', () => {
    const directive: Directive = {
      task: 'insert',
      instruction: 'Add the dictated line under Reminders',
      target: { description: 'Reminders section', heading: 'Reminders' },
      verbatim: 'Standup moved to 9am — bring the Q3 printouts.',
    }
    const call = buildDictationCall(directive, note)
    expect(call.name).toBe('add_text')
    expect(call.params.position).toBe('under_heading')
    expect(call.params.anchor).toBe('Reminders')
    expect(call.params.content).toBe('Standup moved to 9am — bring the Q3 printouts.')
    expect(call.xml).toContain('Standup moved to 9am')
  })

  it('appends when the directive names no heading', () => {
    const directive: Directive = {
      task: 'insert',
      instruction: 'Append the dictated line',
      verbatim: 'Exact words.',
    }
    const call = buildDictationCall(directive, note)
    expect(call.params.position).toBe('append')
    expect(call.params.anchor).toBeUndefined()
    expect(call.params.content).toBe('Exact words.')
  })
})

describe('verbatim is insert-shaped (battery case 6 guard)', () => {
  // The pipeline nulls a model-set verbatim on edit/remove tasks before
  // the dictation branch: a "$1.45M Final" value update is not dictation,
  // and routing it through the harness-built add_text guarantees a d1
  // disapproval. The rule below mirrors runOmniFirstTurn's guard exactly
  // (same conditions, same result) so the contract is pinned in unit.
  function stripMisplacedVerbatim(directive: Directive): Directive {
    return (directive.task === 'edit' || directive.task === 'remove') &&
      typeof directive.verbatim === 'string' &&
      directive.verbatim.trim().length > 0
      ? { ...directive, verbatim: null }
      : directive
  }

  it('nulls verbatim on an edit task (case 6: value update, not dictation)', () => {
    const out = stripMisplacedVerbatim({
      task: 'edit',
      instruction: 'update the Q3 revenue row to $1.45M Final',
      verbatim: '$1.45M Final',
    })
    expect(out.verbatim).toBeNull()
    expect(out.instruction).toContain('$1.45M')
  })

  it('keeps verbatim on insert/create tasks (case 8f dictation)', () => {
    const insert: Directive = {
      task: 'insert',
      instruction: 'Add the dictated line',
      verbatim: 'rotate production keys monthly starting Monday',
    }
    expect(stripMisplacedVerbatim(insert).verbatim).toBe(
      'rotate production keys monthly starting Monday',
    )
  })
})

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

  it('pairs the delegation card by runId even when the execution confirmation comes first', () => {
    // Battery case 21: the execution confirmation ("Inserted 1 line…")
    // is an assistant message with the run's runId; the delegation card
    // now carries it too, so the builder pairs them and the confirmation
    // never leaks in as visible reply history (which taught the front
    // door plain-text delegation, measured 4/4 server-side).
    const directive = { task: 'insert' as const, instruction: 'add the Q4 dates' }
    const history = buildOmniHistory(
      [
        msg({ role: 'user', text: 'add the Q4 dates' }),
        msg({ role: 'assistant', text: 'Inserted 2 lines after line 9.', runId: 'run-1', kind: 'result' }),
        msg({
          role: 'tool',
          text: '',
          runId: 'run-1',
          delegation: { runId: 'run-1', tool: 'add_text', status: 'executed', modelLabel: '1.7B' },
        }),
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
