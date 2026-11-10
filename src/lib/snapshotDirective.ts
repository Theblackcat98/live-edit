/**
 * Snapshot directives: undo/redo are deterministic pipeline actions, never
 * model decisions (design.md §2/§9) — a snapshot rollback must not wait on
 * a model classifying it. This module is the extracted undo/redo core of
 * the deleted supervisor router (`routeCommand` in supervisor.ts): the
 * rest of that router — heuristic route classification, grounding,
 * template authoring — is gone by design; the models route now.
 *
 * The command is lightly normalized first (the supervisor's fixed-point
 * filler/hedge stripping, ported verbatim) so spoken forms like
 * "um, please undo that" still land.
 */

const LEADING_FILLER = /^(?:(?:um|uh|er|ah|hey|okay|ok)[,!.]?\s+)+/i
const SCENE_SETTING =
  /^(?:(?:the|this)\s+(?:document|doc|note|page|file)\s+(?:is|seems|looks)\s+(?:currently\s+|still\s+|totally\s+|completely\s+|already\s+)?(?:empty|blank|clear)\s*(?:now|already|at the moment)?\s*[,.;:]?\s*)+/i
const LEADING_HEDGE =
  /^(?:(?:begin|start)\s+by\s+|go\s+ahead\s+and\s+|i\s+want\s+you\s+to\s+|i'?d\s+like\s+you\s+to\s+|please\s+|just\s+)+/i

/** Strip the spoken scaffolding that precedes a real imperative. Idempotent. */
function normalizeCommand(command: string): string {
  let text = command.trim().replace(/\s+/g, ' ')
  let previous = ''
  while (text !== previous) {
    previous = text
    text = text.replace(LEADING_FILLER, '').replace(SCENE_SETTING, '').replace(LEADING_HEDGE, '')
  }
  return text.trim()
}

export type SnapshotDirective = 'undo' | 'redo'

/**
 * The snapshot directive a command carries, or null when it is not one.
 * Patterns are the supervisor router's, verbatim: a leading imperative, or
 * the verb + a deictic object ("undo that", "redo the last").
 */
export function detectSnapshotDirective(command: string): SnapshotDirective | null {
  const clean = normalizeCommand(command)

  const undo =
    /^(?:please\s+)?(?:undo|revert|roll back)\b/i.test(clean) ||
    /\b(?:undo|revert|roll back)\s+(?:that|this|it|the last|last)\b/i.test(clean)
  if (undo) return 'undo'

  const redo =
    /^(?:please\s+)?(?:redo|reapply)\b/i.test(clean) ||
    /\b(?:redo|reapply)\s+(?:that|this|it|the last|last)\b/i.test(clean) ||
    /\bapply that again\b/i.test(clean)
  if (redo) return 'redo'

  return null
}
