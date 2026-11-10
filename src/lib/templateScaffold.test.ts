import { describe, expect, it } from 'vitest'
import { scaffoldTemplateBrief } from './templateScaffold'
import type { Directive } from '../types'

function createDirective(instruction: string): Directive {
  return { task: 'create', instruction }
}

describe('scaffoldTemplateBrief (design.md §13.1)', () => {
  it('appends the section vocabulary to a bare README-template brief', () => {
    const out = scaffoldTemplateBrief(
      'write a README template document to begin',
      createDirective('Write a README template document to begin'),
    )
    expect(out.instruction).toContain('"Overview"')
    expect(out.instruction).toContain('"Getting Started"')
    expect(out.instruction).toContain('"Usage"')
    expect(out.instruction).toContain('"Contributing"')
    expect(out.instruction).toContain('"License"')
    expect(out.task).toBe('create')
  })

  it('returns the input unchanged when the brief already names sections', () => {
    const directive = createDirective('Write a README with Overview and Usage sections')
    expect(
      scaffoldTemplateBrief('write a README template document to begin', directive),
    ).toBe(directive)
  })

  it('fires only on create-task README-template commands', () => {
    const bare = createDirective('Write a README template document to begin')
    // Non-create task: untouched.
    expect(
      scaffoldTemplateBrief('write a README template document to begin', {
        ...bare,
        task: 'edit',
      }),
    ).toEqual({ ...bare, task: 'edit' })
    // Non-template command: untouched (identity return).
    expect(scaffoldTemplateBrief('summarize the note', bare)).toBe(bare)
    expect(scaffoldTemplateBrief('rename the title to Q3', bare)).toBe(bare)
  })
})
