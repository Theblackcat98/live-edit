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
 * When the note holds only the New-note placeholder (`# Untitled`, battery
 * case 27b), the brief also names the placeholder as replaced: the worker
 * otherwise appends the template under it (measured live: create/append,
 * head stays `# Untitled`, placeholderGone=false) and the bar — placeholder
 * gone from the note entirely — cannot pass.
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
 * The New-note placeholder, exactly as the harness seeds it
 * (useWorkspace newNote): a note holding only this is empty.
 */
export const UNTITLED_PLACEHOLDER = '# Untitled'

/** True when the note holds only the New-note placeholder (modulo blanks). */
export function isUntitledPlaceholder(note: string): boolean {
  return note.trim() === UNTITLED_PLACEHOLDER
}

/**
 * Append the §13.1 section vocabulary to a bare README-template brief.
 * Returns the input directive unchanged when the scaffold does not apply;
 * identity return lets the caller detect the no-op.
 */
export function scaffoldTemplateBrief(
  command: string,
  directive: Directive,
  note?: string,
): Directive {
  if (directive.task !== 'create') return directive
  if (!README_TEMPLATE_COMMAND.test(command)) return directive
  if (namesSection(directive.instruction)) return directive
  const sections = README_SECTIONS.map((section) => `"${section}"`).join(', ')
  const scaffolded: Directive = {
    ...directive,
    instruction:
      `${directive.instruction} Include these sections with markdown headings: ${sections}.`,
  }
  // 27b: the placeholder is content to replace, not a title to keep. Name
  // it so the worker replaces rather than appends under it.
  if (note !== undefined && isUntitledPlaceholder(note)) {
    return {
      ...scaffolded,
      instruction:
        `${scaffolded.instruction} Replace the existing "# Untitled" placeholder heading with the template title — do not keep it.`,
    }
  }
  return scaffolded
}
