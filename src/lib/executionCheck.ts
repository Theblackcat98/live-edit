import type { Directive, ExecutionResult, WorkerCall } from '../types'

/**
 * Post-execution outcome check (battery case 8): the pipeline's "verified"
 * used to certify only that a gate-passing, d1-approved call executed —
 * never that the result matches what was asked. In case 8 the worker
 * authored an insert whose content never carried the user's payload, every
 * downstream layer was satisfied, and the run settled `verified` with the
 * line absent from the note.
 *
 * This check covers the part that is deterministically checkable at the
 * harness layer:
 *  - a no-change execution (the executor's "No change needed" path) must
 *    not settle `verified` — nothing was edited;
 *  - an add_text execution must actually contain the lines its own diff
 *    claims to have inserted;
 *  - when the directive carries `verbatim` (user-dictated exact text), the
 *    executed note must contain it exactly.
 *
 * Semantic misses — the worker paraphrasing a payload it was supposed to
 * carry — are NOT checkable here and remain the d1 check's job; this helper
 * never guesses at intent.
 */
export type ExecutionOutcome =
  | { kind: 'landed' }
  | { kind: 'no-change'; reason: string }
  | { kind: 'missing-content'; reason: string }

export function checkExecutionOutcome(
  noteAtStart: string,
  directive: Directive,
  call: WorkerCall,
  execution: ExecutionResult,
): ExecutionOutcome {
  if (execution.note === noteAtStart) {
    return {
      kind: 'no-change',
      reason: 'The executed call left the note unchanged.',
    }
  }
  if (call.name === 'add_text' && execution.diff) {
    const missing = execution.diff.after.filter(
      (line) => line.trim().length > 0 && !execution.note.includes(line),
    )
    if (missing.length > 0) {
      return {
        kind: 'missing-content',
        reason: `The executed note does not contain ${missing.length} of the line(s) the insert claimed to add (first missing: "${missing[0].slice(0, 80)}").`,
      }
    }
  }
  if (
    typeof directive.verbatim === 'string' &&
    directive.verbatim.trim().length > 0 &&
    !execution.note.includes(directive.verbatim)
  ) {
    return {
      kind: 'missing-content',
      reason: 'The executed note does not contain the dictated text verbatim.',
    }
  }
  return { kind: 'landed' }
}
