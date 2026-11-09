/**
 * Directive schema validation + one-shot repair (design.md §5).
 *
 * The directive is the contract of the whole design: typed, minimal,
 * context-resolved. Emission is Omni's job (omni.ts); this module is the
 * harness's check that what arrived IS a directive — and the single repair
 * retry's error-message builder. Repair failure is a clarify outcome, never a
 * guess (architecture-refactor.md §6.2).
 */
import type { Directive } from '../types'

export type DirectiveValidation =
  | { valid: true; directive: Directive }
  | { valid: false; error: string }

/**
 * Validate an unknown parsed value (typically a native tool-call's arguments
 * object) against the §5 schema. Pure; no I/O.
 */
export function validateDirective(raw: unknown): DirectiveValidation {
  void raw
  throw new Error('directive.ts: filled in by P2 (stub contract)')
}
