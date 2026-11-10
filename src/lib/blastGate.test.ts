import { describe, expect, it } from 'vitest'
import { sectionScaleCollapse } from './blastGate'
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

  it('catches a remove_text that deletes a whole section', () => {
    const c = call('remove_text', {
      start_line: '5',
      end_line: '7',
      target_excerpt:
        '- Supply chain slips could delay the launch by a month\n- Key engineer is a single point of failure for deploys\n- Budget approval still pending from finance leadership',
    })
    const execution = executeTool(NOTE, c)
    expect(execution.ok).toBe(true)
    expect(sectionScaleCollapse(NOTE, execution.diff!)).not.toBeNull()
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

  it('catches a bulk collapse with no heading involved', () => {
    // remove_text has no retention rule (only the 50%-of-note cap), so a
    // 14-line removal inside a 40-line note reaches the gate.
    const filler = Array.from({ length: 14 }, (_, i) => `- filler line ${i + 1} with some text`).join('\n')
    const rest = Array.from({ length: 24 }, (_, i) => `- keep line ${i + 1} with some text`).join('\n')
    const bigNote = ['# Doc', '', filler, '', rest, ''].join('\n')
    const c = call('remove_text', {
      start_line: '3',
      end_line: '16',
      target_excerpt: filler,
    })
    const execution = executeTool(bigNote, c)
    expect(execution.ok).toBe(true)
    const verdict = sectionScaleCollapse(bigNote, execution.diff!)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toContain('14 lines')
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
