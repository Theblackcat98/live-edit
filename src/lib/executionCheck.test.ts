import { describe, expect, it } from 'vitest'
import { checkExecutionOutcome } from './executionCheck'
import { executeTool } from './tools'
import type { Directive, WorkerCall } from '../types'

const NOTE = ['# Q3 Review', '', '## Security', '', '- MFA on', ''].join('\n')

function directive(extra: Partial<Directive> = {}): Directive {
  return { task: 'insert', instruction: 'add the line under Security', ...extra }
}

function call(name: WorkerCall['name'], params: Record<string, string>): WorkerCall {
  return {
    name,
    params,
    thought: '',
    xml: '',
    rawTokens: 0,
    promptHints: [],
    toolSchemasInjected: 0,
    noteView: '',
  }
}

describe('checkExecutionOutcome', () => {
  it('lands a normal add_text whose content is in the executed note', () => {
    const c = call('add_text', {
      position: 'under_heading',
      anchor: 'Security',
      content: '- Rotate keys monthly',
    })
    const execution = executeTool(NOTE, c)
    expect(execution.ok).toBe(true)
    expect(checkExecutionOutcome(NOTE, directive(), c, execution).kind).toBe('landed')
  })

  it('flags the executor no-change path instead of certifying it verified', () => {
    const c = call('edit_text', {
      start_line: '5',
      end_line: '5',
      old_text_anchor: '- MFA on',
      new_text: '- MFA on',
    })
    const execution = executeTool(NOTE, c)
    expect(execution.ok).toBe(true)
    expect(execution.note).toBe(NOTE)
    const outcome = checkExecutionOutcome(NOTE, directive({ task: 'edit' }), c, execution)
    expect(outcome.kind).toBe('no-change')
  })

  it('flags an add_text execution whose claimed lines are absent from the note', () => {
    const c = call('add_text', { position: 'append', content: '- Rotate keys monthly' })
    const execution = {
      ...executeTool(NOTE, c),
      // Simulate an executor/commit drift: diff claims the insert, note lacks it.
      note: NOTE.replace('- MFA on', '- MFA on\n- Something else'),
    }
    const outcome = checkExecutionOutcome(NOTE, directive(), c, execution)
    expect(outcome.kind).toBe('missing-content')
  })

  it('requires dictated verbatim text to land exactly', () => {
    const c = call('add_text', {
      position: 'under_heading',
      anchor: 'Security',
      content: '- Rotate production keys monthly starting Monday',
    })
    const good = executeTool(NOTE, c)
    expect(
      checkExecutionOutcome(
        NOTE,
        directive({ verbatim: 'Rotate production keys monthly starting Monday' }),
        c,
        good,
      ).kind,
    ).toBe('landed')

    const drifted = { ...good, note: good.note.replace('starting Monday', 'starting Tuesday') }
    const outcome = checkExecutionOutcome(
      NOTE,
      directive({ verbatim: 'Rotate production keys monthly starting Monday' }),
      c,
      drifted,
    )
    expect(outcome.kind).toBe('missing-content')
  })

  it('lands edit and remove executions that changed the note', () => {
    const edit = call('edit_text', {
      start_line: '5',
      end_line: '5',
      old_text_anchor: '- MFA on',
      new_text: '- MFA enforced for all admins',
    })
    expect(
      checkExecutionOutcome(NOTE, directive({ task: 'edit' }), edit, executeTool(NOTE, edit)).kind,
    ).toBe('landed')
    const remove = call('remove_text', {
      start_line: '5',
      end_line: '5',
      target_excerpt: '- MFA on',
    })
    expect(
      checkExecutionOutcome(NOTE, directive({ task: 'remove' }), remove, executeTool(NOTE, remove))
        .kind,
    ).toBe('landed')
  })
})
