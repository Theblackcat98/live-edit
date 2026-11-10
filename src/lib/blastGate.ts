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
 * Narrowing (Nick's call, 2026-11-10, after battery case 23): the
 * forbidden class is destruction disguised as an edit — a section
 * replaced by a stub under an edit tool. An outright deletion is a
 * different shape: the user asked for a removal in plain words and the
 * worker grounded it with the remove tool. `remove_text` calls are
 * therefore exempt from this gate and execute on d1's approval like any
 * other edit (the executor's own removal caps still bound them). An
 * edit-tool call that empties a section stays held — that is the
 * disguised shape, whatever the command said.
 */
export function sectionScaleCollapse(
  note: string,
  diff: ExecutionDiff,
  tool?: string,
): CollapseVerdict | null {
  if (tool === 'remove_text') return null
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
