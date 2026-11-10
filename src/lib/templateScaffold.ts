import type { Directive } from '../types'

/**
 * Template scaffold (battery cases 27/27b/12/12d — design.md §13.1).
 *
 * The §13.1 bar needs a real multi-section README (title + ≥4 of the five
 * standard sections as H2/H3 headings). Measured live, the front door
 * echoes the command into the brief ("Write a README template document to
 * begin" — no section list), and the worker then authors 1–3 sections.
 * The scaffold appends the fixed section vocabulary to the instruction —
 * scaffolding, not content: the worker still authors every word, and d1
 * still judges the call.
 *
 * Narrow firing conditions (never rewrites a real user brief):
 * - directive task is `create` (template authoring, not an edit),
 * - the command asks for a README *template* (readme + template words),
 * - the instruction names none of the five sections already.
 */
export const README_SECTIONS = [
  'Overview',
  'Getting Started',
  'Usage',
  'Contributing',
  'License',
] as const

const README_TEMPLATE_COMMAND = /\breadme\b.+\btemplate\b|\btemplate\b.+\breadme\b/i

function namesSection(text: string): boolean {
  return README_SECTIONS.some((section) =>
    new RegExp(`\\b${section}\\b`, 'i').test(text),
  )
}

/**
 * Append the §13.1 section vocabulary to a bare README-template brief.
 * Returns the input directive unchanged when the scaffold does not apply;
 * identity return lets the caller detect the no-op.
 */
export function scaffoldTemplateBrief(command: string, directive: Directive): Directive {
  if (directive.task !== 'create') return directive
  if (!README_TEMPLATE_COMMAND.test(command)) return directive
  if (namesSection(directive.instruction)) return directive
  const sections = README_SECTIONS.map((section) => `"${section}"`).join(', ')
  return {
    ...directive,
    instruction:
      `${directive.instruction} Include these sections with markdown headings: ${sections}.`,
  }
}
