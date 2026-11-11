import type { Directive } from '../types'
import { findSectionEnd, getHeadings, splitLines } from './doc'
import type { ExecutionDiff } from '../types'

export interface CollapseVerdict {
  reason: string
}

/**
 * The §8 blast-radius hold (issue #58; battery cases 12c and 29): d1's
 * approval is necessary for a silent edit, but it is not sufficient for a
 * section-scale collapse. Twice on the battery, d1 approved exactly the
 * class §8 forbids auto-verifying — a whole section replaced by a stub —
 * and the edit executed silently. Prompt calibration did not fix the
 * verdict, so the boundary is deterministic instead:
 *
 *  - a diff that swallows an entire section (starts at its heading or
 *    first body line, ends at or past its last line) while keeping under
 *    half of its characters, or
 *  - a bulk diff removing 12+ lines while keeping under 30% of the
 *    characters,
 *
 * is held for the user's ✓/✗ even when d1 approved. A hold is not a
 * refusal — the user can still apply it — it only removes the silence.
 * Small or content-preserving edits are untouched by this gate.
 *
 * Tool/directive/command scoping (issue #58 follow-up; battery cases
 * 12c/29 versus case 23): the forbidden class is destruction of
 * section-scale content the user did not ask to delete. An outright
 * deletion the user asked for in plain words (a plain-removal command,
 * directive task `remove`, grounded with the remove tool — case 23's
 * shape: "remove that section about API keys") executes on d1's approval
 * like any other edit; the executor's own removal caps still bound it.
 * But a section-scale removal whose command asked for a replacement (the
 * live 12c/29 shape: "Replace the Risks section with tiny" — Omni tasks
 * it as remove, the worker deletes the section because no edit shape
 * passes the retention gates, d1 approves at noul 0.60) is destruction
 * disguised by tool choice, and it is held whatever the tool and task. A
 * remove_text under a non-remove directive, and an edit-tool call that
 * empties a section, stay held — those are the disguised shapes.
 */

/**
 * Replacement intent in a raw user command: the command names new content
 * to put in place of the old (replace X with Y, change/update/rename A to
 * B, rewrite A as B). A plain removal ("remove that section", "delete the
 * bullet") carries no replacement complement and returns false. Same
 * deterministic-command-reading philosophy as the pipeline's
 * snapshot-directive detector: the user's phrasing, not a model verdict.
 */
export function hasReplacementIntent(command: string | undefined): boolean {
  if (!command) return false
  return (
    /\breplac\w*\b.+?\bwith\b/i.test(command) ||
    /\b(chang\w*|updat\w*|renam\w*|rewrit\w*|rewrot\w*|convert\w*|swap\w*)\b.+?\bto\b/i.test(command) ||
    /\brewrit\w*\b.+?\bas\b/i.test(command)
  )
}
export function sectionScaleCollapse(
  note: string,
  diff: ExecutionDiff,
  tool?: string,
  directiveTask?: Directive['task'],
  command?: string,
): CollapseVerdict | null {
  // The case-23 shape: the directive asked for a removal, the command is a
  // plain removal (no replacement phrasing), and the worker grounded it
  // with the remove tool. That executes on d1's approval. Every other
  // section-scale destruction is held — including a remove_text call whose
  // command asked for a replacement (the live 12c/29 shape: Omni tasks
  // "Replace the Risks section with tiny" as remove, the worker deletes
  // the section, d1 approves at noul 0.60, and the silence would violate
  // §8), and any remove_text under a non-remove directive.
  if (
    tool === 'remove_text' &&
    directiveTask === 'remove' &&
    !hasReplacementIntent(command)
  )
    return null
  if (diff.removed < 2) return null
  const beforeChars = diff.before.join('\n').length
  if (beforeChars === 0) return null
  const afterChars = diff.after.join('\n').trim().length
  const rangeStart = diff.startLine
  const rangeEnd = diff.startLine + diff.removed - 1

  const lines = splitLines(note)
  for (const heading of getHeadings(note)) {
    // The section's first content line (blank separators after the heading
    // don't count): a range starting at the heading or at that line can
    // swallow the section; one starting below it cannot.
    let firstContentLine = heading.line + 1
    while (
      firstContentLine <= lines.length &&
      (lines[firstContentLine - 1] ?? '').trim() === ''
    ) {
      firstContentLine += 1
    }
    if (rangeStart > firstContentLine) continue
    // The section's last content line: findSectionEnd counts trailing blank
    // separator lines as part of the section, but a worker's range ends at
    // the last content line — compare against that.
    let sectionLastLine = findSectionEnd(note, heading) - 1
    while (sectionLastLine > heading.line && (lines[sectionLastLine - 1] ?? '').trim() === '') {
      sectionLastLine -= 1
    }
    if (rangeEnd >= sectionLastLine && afterChars < beforeChars * 0.5) {
      return {
        reason: `replaces the entire "${heading.title}" section (${diff.removed} lines, ${beforeChars} characters) with ${afterChars} characters`,
      }
    }
  }

  if (diff.removed >= 12 && afterChars < beforeChars * 0.3) {
    return {
      reason: `removes ${diff.removed} lines (${beforeChars} characters) and keeps only ${afterChars} characters`,
    }
  }

  return null
}
