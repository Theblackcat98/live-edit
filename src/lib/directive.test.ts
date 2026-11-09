import { describe, expect, it } from 'vitest'
import type { Directive } from '../types'
import {
  buildDirectiveRepairMessage,
  INSTRUCTION_MAX_CHARS,
  validateDirective,
} from './directive'

/** The design.md §5 reference directive. */
const SECTION_FIVE_EXAMPLE = {
  task: 'create',
  instruction:
    'Write a README template document to begin the note: title it README and give it the standard ' +
    'sections — overview, getting started, usage, contributing, license. The note currently holds a ' +
    'Q3 review; the user wants the template at the top.',
  target: {
    description: 'top of the note, before the Q3 Business Review heading',
    heading: null,
  },
  verbatim: null,
  constraints: ['markdown', 'keep the existing Q3 content intact'],
  frame_relevant: false,
}

describe('validateDirective — valid', () => {
  it('accepts the §5 reference example unchanged', () => {
    const result = validateDirective(SECTION_FIVE_EXAMPLE)
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.directive.task).toBe('create')
    expect(result.directive.instruction).toBe(SECTION_FIVE_EXAMPLE.instruction)
    expect(result.directive.target).toEqual({
      description: SECTION_FIVE_EXAMPLE.target.description,
      heading: null,
    })
    expect(result.directive.verbatim).toBeNull()
    expect(result.directive.constraints).toEqual(SECTION_FIVE_EXAMPLE.constraints)
    expect(result.directive.frame_relevant).toBe(false)
  })

  it('accepts the minimal directive: task + instruction', () => {
    const result = validateDirective({
      task: 'remove',
      instruction: 'Remove the bullet about Redis caching from the Risks section.',
    })
    expect(result).toEqual({
      valid: true,
      directive: { task: 'remove', instruction: 'Remove the bullet about Redis caching from the Risks section.' },
    })
  })

  it('ignores unknown extra properties (documented decision)', () => {
    const result = validateDirective({
      task: 'edit',
      instruction: 'Update the Q3 revenue row to $1.45M Final.',
      why: 'because the user said so',
      priority: 3,
    })
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(Object.keys(result.directive)).toEqual(['task', 'instruction'])
  })

  it('normalizes absent/null optionals', () => {
    const result = validateDirective({
      task: 'insert',
      instruction: "Add a bullet under Follow-ups: send the deck to finance.",
      target: null,
      constraints: null,
    })
    expect(result.valid).toBe(true)
    if (!result.valid) return
    const directive: Directive = result.directive
    expect(directive.target).toBeUndefined()
    expect(directive.constraints).toBeUndefined()
    expect(directive.verbatim).toBeUndefined()
    expect(directive.frame_relevant).toBeUndefined()
  })

  it('normalizes an absent target.heading to null and keeps a stated one', () => {
    const noHeading = validateDirective({
      task: 'insert',
      instruction: 'Add a line under Security about rotating keys monthly.',
      target: { description: 'the Security section' },
    })
    expect(noHeading.valid).toBe(true)
    if (noHeading.valid) expect(noHeading.directive.target?.heading).toBeNull()

    const withHeading = validateDirective({
      task: 'edit',
      instruction: 'Rename the title to Q3 Review Final.',
      target: { description: 'the document title', heading: 'Q3 Business Review' },
    })
    expect(withHeading.valid).toBe(true)
    if (withHeading.valid) expect(withHeading.directive.target?.heading).toBe('Q3 Business Review')
  })

  it('keeps verbatim dictated text as the one legitimate content carrier', () => {
    const result = validateDirective({
      task: 'insert',
      instruction: 'Insert the dictated sentence verbatim under the Wins section.',
      verbatim: 'LTV/CAC held at 3.4x despite the churn spike.',
    })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.directive.verbatim).toBe('LTV/CAC held at 3.4x despite the churn spike.')
  })
})

describe('validateDirective — invalid kinds', () => {
  it('rejects non-objects', () => {
    for (const raw of ['edit', 42, null, true, ['task'], undefined]) {
      const result = validateDirective(raw)
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/not a JSON object/)
    }
  })

  it('rejects a missing or out-of-enum task', () => {
    for (const task of [undefined, 'update', 'delete', 'EDIT', 7]) {
      const result = validateDirective({ task, instruction: 'A perfectly fine brief.' })
      expect(result.valid, `task=${String(task)}`).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/task must be one of/)
    }
  })

  it('rejects a missing, empty, whitespace, or non-string instruction', () => {
    for (const instruction of [undefined, '', '   ', 42, { brief: true }]) {
      const result = validateDirective({ task: 'edit', instruction })
      expect(result.valid, `instruction=${String(instruction)}`).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/instruction must be a non-empty string/)
    }
  })

  it(`rejects whole-content-in-instruction drift via the ${INSTRUCTION_MAX_CHARS}-char length heuristic (E1 T13)`, () => {
    const drifted = `# README

## Overview
This project is a local-first multimodal note workspace driven by a trio of
small local models. It runs entirely on one machine, keeps its data in plain
markdown, and is operated primarily by voice during hands-free working
sessions.

## Getting Started
Clone the repository, install dependencies with npm install, start the three
model servers with scripts/start-models.sh, then run npm run dev and open the
printed local address. The workspace seeds one demo note on first launch.

## Usage
Talk to Omni; answers stream into the session column and edits land in the
note as diff cards. Undo and redo walk the snapshot stack. The activity tabs
show every pipeline stage's live runtime provenance.

## Contributing
Pull requests are welcome; keep the bundle small, avoid new runtime
dependencies, and preserve the runtime-honesty guarantees in the trace.

## License
MIT.`
    expect(drifted.length).toBeGreaterThan(INSTRUCTION_MAX_CHARS)
    const result = validateDirective({ task: 'create', instruction: drifted })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toMatch(/content itself, not a brief/)
      expect(result.error).toContain(String(drifted.length))
      expect(result.error).toContain(String(INSTRUCTION_MAX_CHARS))
    }

    // A long-but-honest brief at exactly the cap stays valid.
    const honest = 'A'.repeat(INSTRUCTION_MAX_CHARS)
    expect(validateDirective({ task: 'create', instruction: honest }).valid).toBe(true)
  })

  it('rejects malformed target shapes', () => {
    const cases: unknown[] = [
      'top of the note',
      { description: '   ' },
      { description: '' },
      { heading: 'Revenue' },
      { description: 'the revenue table', heading: 7 },
      { description: 'the revenue table', heading: ['Revenue'] },
    ]
    for (const target of cases) {
      const result = validateDirective({ task: 'edit', instruction: 'Update the Q3 row.', target })
      expect(result.valid, `target=${JSON.stringify(target)}`).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/target/)
    }
  })

  it('rejects malformed verbatim values', () => {
    for (const verbatim of ['', '   ', 42, ['text']]) {
      const result = validateDirective({ task: 'insert', instruction: 'Insert the dictated line.', verbatim })
      expect(result.valid, `verbatim=${JSON.stringify(verbatim)}`).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/verbatim/)
    }
  })

  it('rejects malformed constraints values', () => {
    for (const constraints of ['markdown', { 0: 'markdown' }, ['markdown', 42], ['markdown', '']]) {
      const result = validateDirective({ task: 'insert', instruction: 'Add the row.', constraints })
      expect(result.valid, `constraints=${JSON.stringify(constraints)}`).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/constraints/)
    }
  })

  it('rejects a non-boolean frame_relevant', () => {
    for (const frameRelevant of ['yes', 1, null]) {
      const result = validateDirective({ task: 'extract', instruction: 'Pull the formula off the slide.', frame_relevant: frameRelevant })
      expect(result.valid, `frame_relevant=${JSON.stringify(frameRelevant)}`).toBe(false)
      if (!result.valid) expect(result.error).toMatch(/frame_relevant must be a boolean/)
    }
  })

  it('joins every error when several fields are wrong at once', () => {
    const result = validateDirective({ task: 'swap', instruction: '', constraints: 'none' })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toMatch(/task must be one of/)
      expect(result.error).toMatch(/instruction must be a non-empty string/)
      expect(result.error).toMatch(/constraints/)
    }
  })
})

describe('buildDirectiveRepairMessage', () => {
  it('carries the schema error verbatim and re-states the brief-not-content rule', () => {
    const error = 'task must be one of create|insert|edit|remove|extract (got "update")'
    const message = buildDirectiveRepairMessage(error)
    expect(message).toContain(error)
    expect(message).toMatch(/Call delegate_edit again/)
    expect(message).toMatch(/brief, not the content/)
    expect(message).toMatch(/sections named, values given/)
  })

  it('is model-facing context, never assistant-channel content (E1 run-3 discipline)', () => {
    // The message is appended as a USER-role turn by omni.ts; this test pins
    // that it names the tool and the rule but never pretends to be Omni.
    const message = buildDirectiveRepairMessage('the directive arguments are not a JSON object')
    expect(message).toMatch(/^That delegate_edit call was rejected/)
  })
})
