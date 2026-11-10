import { describe, expect, it } from 'vitest'
import { hasReplacementIntent, sectionScaleCollapse } from './blastGate'
import { executeTool } from './tools'
import type { WorkerCall } from '../types'

const NOTE = [
  '# Q3 Review',
  '',
  '## Risks',
  '',
  '- Supply chain slips could delay the launch by a month',
  '- Key engineer is a single point of failure for deploys',
  '- Budget approval still pending from finance leadership',
  '',
  '## Roadmap',
  '',
  '- Ship beta in October',
  '- Hire one more engineer',
  '',
].join('\n')

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

describe('sectionScaleCollapse', () => {
  it('catches the case-29 shape: whole Risks section collapsed to a stub', () => {
    // The range starts at the heading itself and ends at the section's last
    // content line. The replacement keeps ~38% of the characters — enough
    // to pass the executor's 30% retention refusal, still a collapse the
    // §8 rule must hold (under 50% at whole-section scale).
    const wide = call('edit_text', {
      start_line: '3',
      end_line: '7',
      old_text_anchor:
        '## Risks\n\n- Supply chain slips could delay the launch by a month\n- Key engineer is a single point of failure for deploys\n- Budget approval still pending from finance leadership',
      new_text: '## Risks\n\n- Supply chain and staffing risks remain, pending review.',
    })
    const wideExecution = executeTool(NOTE, wide)
    expect(wideExecution.ok).toBe(true)
    expect(sectionScaleCollapse(NOTE, wideExecution.diff!)).not.toBeNull()
  })

  it('exempts a plain-removal remove_text under a remove directive (case 23)', () => {
    // Case 23's shape: a plain-removal command, a remove directive, the
    // worker grounded it with the remove tool — that executes on d1's
    // approval; the gate only holds destruction the user did not ask to
    // delete.
    const c = call('remove_text', {
      start_line: '5',
      end_line: '7',
      target_excerpt:
        '- Supply chain slips could delay the launch by a month\n- Key engineer is a single point of failure for deploys\n- Budget approval still pending from finance leadership',
    })
    const execution = executeTool(NOTE, c)
    expect(execution.ok).toBe(true)
    expect(sectionScaleCollapse(NOTE, execution.diff!, 'remove_text', 'remove', 'remove that section about API keys')).toBeNull()
    // The same diff under an edit tool stays held.
    expect(sectionScaleCollapse(NOTE, execution.diff!, 'edit_text')).not.toBeNull()
  })

  it('holds a section-scale remove_text whose command asks for a replacement (live 12c/29)', () => {
    // The observed live shape: Omni tasks "Replace the Risks section with
    // tiny" as remove, the worker deletes the section (the only
    // gate-passing shape — no edit passes the retention gates), d1 approves
    // at noul 0.60. The command names replacement content, so the deletion
    // is destruction disguised by tool choice: held whatever tool and task.
    const c = call('remove_text', {
      start_line: '3',
      end_line: '7',
      target_excerpt:
        '## Risks\n\n- Supply chain slips could delay the launch by a month\n- Key engineer is a single point of failure for deploys\n- Budget approval still pending from finance leadership',
    })
    const execution = executeTool(NOTE, c)
    expect(execution.ok).toBe(true)
    expect(sectionScaleCollapse(NOTE, execution.diff!, 'remove_text', 'remove', 'Replace the Risks section with tiny')).not.toBeNull()
    // Also held under a non-remove directive or with no command at all.
    expect(sectionScaleCollapse(NOTE, execution.diff!, 'remove_text', 'edit', 'Replace the Risks section with tiny')).not.toBeNull()
    expect(sectionScaleCollapse(NOTE, execution.diff!, 'remove_text')).not.toBeNull()
  })

  it('reads replacement intent off the command phrasing', () => {
    expect(hasReplacementIntent('Replace the Risks section with tiny')).toBe(true)
    expect(hasReplacementIntent('change the Q3 row to $1.45M')).toBe(true)
    expect(hasReplacementIntent('update the title to Final')).toBe(true)
    expect(hasReplacementIntent('rename the title to Q3 Review Final')).toBe(true)
    expect(hasReplacementIntent('rewrite the intro as a summary')).toBe(true)
    expect(hasReplacementIntent('remove that section about API keys')).toBe(false)
    expect(hasReplacementIntent('delete the bullet about the audit')).toBe(false)
    expect(hasReplacementIntent('remove the bullet about Redis')).toBe(false)
    expect(hasReplacementIntent(undefined)).toBe(false)
  })

  it('leaves a partial-section edit alone', () => {
    const c = call('edit_text', {
      start_line: '5',
      end_line: '5',
      old_text_anchor: '- Supply chain slips could delay the launch by a month',
      new_text: '- Supply chain slips could delay the launch by six weeks',
    })
    const execution = executeTool(NOTE, c)
    expect(execution.ok).toBe(true)
    expect(sectionScaleCollapse(NOTE, execution.diff!)).toBeNull()
  })

  it('leaves a full-section rewrite that keeps most of the content alone', () => {
    const c = call('edit_text', {
      start_line: '5',
      end_line: '7',
      old_text_anchor:
        '- Supply chain slips could delay the launch by a month\n- Key engineer is a single point of failure for deploys\n- Budget approval still pending from finance leadership',
      new_text:
        '- Supply chain risk: launch may slip a month without a second vendor\n- Deploy knowledge is concentrated in one engineer; pair on releases\n- Finance leadership still owes a budget decision this quarter',
    })
    const execution = executeTool(NOTE, c)
    expect(execution.ok).toBe(true)
    expect(sectionScaleCollapse(NOTE, execution.diff!)).toBeNull()
  })

  it('catches a bulk collapse with no heading involved (edit tool)', () => {
    const filler = Array.from({ length: 14 }, (_, i) => `- filler line ${i + 1} with some text`)
    const rest = Array.from({ length: 24 }, (_, i) => `- keep line ${i + 1} with some text`).join('\n')
    const bigNote = ['# Doc', '', filler.join('\n'), '', rest, ''].join('\n')
    // The diff is constructed directly: the executor's own retention rule
    // refuses this edit before the gate would see it, but the gate is a
    // pure function of the diff and must still classify the shape.
    const diff = { startLine: 3, before: filler, after: ['- summary'], added: 1, removed: 14 }
    const verdict = sectionScaleCollapse(bigNote, diff, 'edit_text')
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toContain('14 lines')
    // The same span deleted outright via the remove tool under a remove
    // directive (explicit deletion) stays exempt.
    const rm = call('remove_text', {
      start_line: '3',
      end_line: '16',
      target_excerpt: filler.join('\n'),
    })
    const rmExecution = executeTool(bigNote, rm)
    expect(rmExecution.ok).toBe(true)
    expect(sectionScaleCollapse(bigNote, rmExecution.diff!, 'remove_text', 'remove')).toBeNull()
  })

  it('ignores a small removal inside a section', () => {
    const c = call('remove_text', {
      start_line: '11',
      end_line: '11',
      target_excerpt: '- Ship beta in October',
    })
    const execution = executeTool(NOTE, c)
    expect(execution.ok).toBe(true)
    expect(sectionScaleCollapse(NOTE, execution.diff!)).toBeNull()
  })
})
