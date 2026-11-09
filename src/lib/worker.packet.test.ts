import { describe, expect, it } from 'vitest'
import type { ContextPacket, Directive } from '../types'
import { INITIAL_NOTE, NOTE_PATH } from '../data/note'
import {
  PACKET_WORKER_SYSTEM_PROMPT,
  buildPacketWorkerMessages,
  buildWorkerRetryMessages,
  numberNoteLines,
  renderPacketToolCatalog,
} from './worker'

/** design.md §5 reference directive (the §13.1 README brief). */
const README_DIRECTIVE: Directive = {
  task: 'create',
  instruction:
    'Write a README template document to begin the note: title it README and give it the standard ' +
    'sections — overview, getting started, usage, contributing, license.',
  target: { description: 'top of the note, before the Q3 Business Review heading', heading: null },
  verbatim: null,
  constraints: ['markdown', 'keep the existing Q3 content intact'],
  frame_relevant: false,
}

const THREE_TURN_PACKET: ContextPacket = {
  editTurns: [
    {
      command: 'Rename the title to Q3 Review Final',
      directiveSummary: 'edit · Replace the H1 title with "# Q3 Review Final".',
      diffSummary: 'edit_text lines 1–1 (applied).',
    },
    {
      command: 'remove the bullet about Redis',
      directiveSummary: 'remove · Delete the Product notes Redis bullet.',
      diffSummary: 'remove_text 1 line (applied).',
    },
    {
      command: 'update the Q3 revenue row to $1.45M Final',
      directiveSummary: 'edit · Set the Q3 row to $1.45M / Final.',
      diffSummary: 'edit_text 1 line (applied).',
    },
  ],
  promptTokens: 96,
}

function build(directive: Directive = README_DIRECTIVE, contextPacket: ContextPacket = THREE_TURN_PACKET) {
  return buildPacketWorkerMessages({ directive, contextPacket, note: INITIAL_NOTE })
}

function userText(messages: ReturnType<typeof build>): string {
  expect(messages[0].role).toBe('system')
  expect(messages[1].role).toBe('user')
  return String(messages[1].content)
}

describe('numberNoteLines — the shared numbering discipline', () => {
  it('numbers every line of a 40+ line note in the tokenViewForWorker gutter format', () => {
    const lines = INITIAL_NOTE.split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(40)
    const numbered = numberNoteLines(INITIAL_NOTE)
    const numberedLines = numbered.split('\n')
    expect(numberedLines).toHaveLength(lines.length)
    expect(numberedLines[0]).toBe('  1 │ # Q3 Business Review')
    expect(numberedLines[16]).toBe(' 17 │ | Q3 | $1.2M | Pending |')
    expect(numberedLines[40]).toBe(' 41 │ - Rotate production API keys before 30 November.')
    // Numbers are right-aligned to a 3-wide column, 1-based, contiguous.
    numberedLines.forEach((line, index) => {
      expect(line.startsWith(`${String(index + 1).padStart(3, ' ')} │ `)).toBe(true)
    })
  })
})

describe('buildPacketWorkerMessages — assembly (design.md §6)', () => {
  it('is [system, user] with the packet system prompt', () => {
    const messages = build()
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'system', content: PACKET_WORKER_SYSTEM_PROMPT })
  })

  it('carries the FULL note, every line numbered', () => {
    const text = userText(build())
    expect(text).toContain('CURRENT NOTE')
    expect((text.match(/^\s*\d+ │ /gm) ?? []).length).toBe(INITIAL_NOTE.split('\n').length)
    // First and last content lines of the seed note are both present,
    // gutter-numbered — the ±3-line window defect is gone.
    expect(text).toContain('  1 │ # Q3 Business Review')
    expect(text).toContain(` 41 │ - Rotate production API keys before 30 November.`)
    expect(text).toContain(NOTE_PATH)
  })

  it('renders all 4 tool schemas so the worker CHOOSES (task is a hint, not a filter)', () => {
    const text = userText(build())
    for (const schema of ['add_text', 'edit_text', 'remove_text', 'extract_visual_to_note']) {
      expect(text).toContain(`<schema function=${schema}>`)
    }
    // The directive's task hint names a tool but the catalog carries all four.
    expect(text).toContain('you pick the tool that fits')
    expect(text.match(/<schema function=/g)).toHaveLength(4)
  })

  it('includes the context packet turns, in order, oldest first', () => {
    const text = userText(build())
    const positions = THREE_TURN_PACKET.editTurns.map((turn) => text.indexOf(turn.command))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const turn of THREE_TURN_PACKET.editTurns) {
      expect(text).toContain(turn.directiveSummary)
      expect(text).toContain(turn.diffSummary)
    }
  })

  it('renders the directive with task, instruction, verbatim and constraints', () => {
    const directive: Directive = {
      task: 'insert',
      instruction: 'Add a line to the Security section.',
      target: { description: 'under the Security heading', heading: '6. Security' },
      verbatim: 'rotate keys monthly',
      constraints: ['keep the existing Security bullets'],
      frame_relevant: false,
    }
    const text = userText(build(directive))
    expect(text).toContain('"task": "insert"')
    expect(text).toContain(directive.instruction)
    expect(text).toContain('"verbatim": "rotate keys monthly"')
    expect(text).toContain('"keep the existing Security bullets"')
  })

  it('renders an empty context packet as the first-edit marker', () => {
    const text = userText(build(README_DIRECTIVE, { editTurns: [], promptTokens: 0 }))
    expect(text).toContain('first edit of the session')
  })

  it('carries the frame_extract field when Omni read the frame (decision D2)', () => {
    const text = userText(
      build({
        task: 'extract',
        instruction: 'Pull the LTV/CAC formula from the slide into Revenue.',
        frame_relevant: true,
        frame_extract: '**North star — LTV / CAC**\n\n$$\n\\frac{\\mathrm{LTV}}{\\mathrm{CAC}} = 3.4\\times\n$$',
      } as Directive & { frame_extract: string }),
    )
    expect(text).toContain('LTV / CAC')
  })

  it('contains NO supervisor-authored content or supervisor vocabulary', () => {
    const messages = build()
    const all = messages.map((m) => String(m.content)).join('\n')
    // The shipped supervisor prompt's authored-content channels.
    for (const banned of [
      'Supervisor hints',
      'Supervisor-proposed',
      'Tool to call:',
      'Grounded span:',
      'Insertion: position=',
      'allowed tool pruned',
      'supplied by the supervisor',
      'line-numbered note window',
      'full file withheld',
    ]) {
      expect(all).not.toContain(banned)
    }
    // No authored note content beyond the note itself: nothing that looks like
    // a harness-written README/bullet body appears outside the numbered note
    // (the directive's brief and the catalog examples are the exceptions, and
    // they are Omni's brief and per-tool syntax demos respectively).
    expect(all).not.toMatch(/# README[\s\S]*## Overview/)
  })

  it('each catalog schema carries a filled PROSE example naming only its own parameters, never a <tool_call> block', () => {
    const catalog = renderPacketToolCatalog(NOTE_PATH)
    // v2 lesson: complete XML examples in the catalog were read by the 1.7B as
    // its own prior assistant turns — examples stay prose.
    expect(catalog).not.toContain('<tool_call>')
    expect(catalog.match(/Filled example/g)).toHaveLength(4)
    const ownership: Record<string, string[]> = {
      add_text: ['file_path', 'position', 'anchor', 'content'],
      edit_text: ['file_path', 'start_line', 'end_line', 'old_text_anchor', 'new_text'],
      remove_text: ['file_path', 'start_line', 'end_line', 'target_excerpt'],
      extract_visual_to_note: ['file_path', 'visual_format', 'anchor_heading', 'extracted_markdown'],
    }
    for (const [tool, params] of Object.entries(ownership)) {
      const block = catalog.slice(
        catalog.indexOf(`<schema function=${tool}>`),
        catalog.indexOf('</schema>', catalog.indexOf(`<schema function=${tool}>`)),
      )
      for (const param of params) expect(block).toContain(`${param}=`)
    }
    // The syntax the examples deliberately omit is taught abstractly once, in
    // the system prompt.
    expect(PACKET_WORKER_SYSTEM_PROMPT).toContain('<function=TOOL_NAME>')
    expect(PACKET_WORKER_SYSTEM_PROMPT).toContain('<parameter=NAME>')
  })
})

describe('buildWorkerRetryMessages — the concrete correction (E4 class c)', () => {
  const retry = buildWorkerRetryMessages({
    original: { directive: README_DIRECTIVE, contextPacket: THREE_TURN_PACKET, note: INITIAL_NOTE },
    attemptText: '<tool_call>\n<function=edit_text>\n…truncated…\n</tool_call>',
    error: 'the edit_text call has parameter problems: missing required param "new_text"',
    attemptedTool: 'edit_text',
    anchorCorrection: null,
  })

  it('is the original conversation plus the rejected reply and the correction turn', () => {
    expect(retry).toHaveLength(4)
    expect(retry[0].role).toBe('system')
    expect(retry[1].role).toBe('user')
    expect(retry[2]).toEqual({ role: 'assistant', content: '<tool_call>\n<function=edit_text>\n…truncated…\n</tool_call>' })
    expect(retry[3].role).toBe('user')
  })

  it('carries the exact error verbatim', () => {
    const text = String(retry[3].content)
    expect(text).toContain('Exact error: the edit_text call has parameter problems: missing required param "new_text"')
  })

  it('restates the attempted tool’s exact full parameter list', () => {
    const text = String(retry[3].content)
    expect(text).toContain('Your call was named "edit_text"')
    for (const param of ['- file_path (string, required)', '- start_line (integer, required)', '- end_line (integer, required)', '- old_text_anchor (string, required)', '- new_text (string, required)']) {
      expect(text).toContain(param)
    }
  })

  it('carries the note’s actual text on an anchor miss', () => {
    const messages = buildWorkerRetryMessages({
      original: { directive: README_DIRECTIVE, contextPacket: THREE_TURN_PACKET, note: INITIAL_NOTE },
      attemptText: 'attempt',
      error: 'anchor mismatch at lines 17–17',
      attemptedTool: 'edit_text',
      anchorCorrection: { startLine: 17, endLine: 17, actualText: '| Q3 | $1.2M | Pending |' },
    })
    const text = String(messages[3].content)
    expect(text).toContain('The note\'s actual text at lines 17–17')
    expect(text).toContain('| Q3 | $1.2M | Pending |')
    expect(text).toContain('old_text_anchor')
  })

  it('uses target_excerpt, not old_text_anchor, when the rejected call was remove_text', () => {
    const messages = buildWorkerRetryMessages({
      original: { directive: README_DIRECTIVE, contextPacket: THREE_TURN_PACKET, note: INITIAL_NOTE },
      attemptText: 'attempt',
      error: 'anchor mismatch at lines 25–25',
      attemptedTool: 'remove_text',
      anchorCorrection: { startLine: 25, endLine: 25, actualText: '- Redis cache migration was postponed to Q4.' },
    })
    expect(String(messages[3].content)).toContain('target_excerpt')
  })

  it('contains no fill-in XML skeleton the worker could echo literally (E4 F03)', () => {
    const text = String(retry[3].content)
    expect(text).not.toContain('tool_name')
    expect(text).not.toContain('param_name')
    expect(text).not.toMatch(/<function=[a-z_]*>/)
  })
})
