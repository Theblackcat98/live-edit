/**
 * Directive schema validation + one-shot repair (design.md §5).
 *
 * The directive is the contract of the whole design: typed, minimal,
 * context-resolved. Emission is Omni's job (omni.ts, native tool calls per
 * E1/D4); this module is the harness's check that what arrived IS a directive —
 * and the single repair retry's message builder. Repair failure is a clarify
 * outcome, never a guess (architecture-refactor.md §6.2).
 *
 * Validation decisions, documented:
 *
 * - `instruction` must be a non-empty string. The §5 "a brief, not the
 *   content" rule (E1's failure class: T13 packed the entire authored README
 *   into the instruction) is enforced ONLY by a length heuristic: instructions
 *   longer than {@link INSTRUCTION_MAX_CHARS} characters are rejected as
 *   content-drift. The §5 reference example is ~240 chars; 600 admits every
 *   honest multi-constraint brief while catching whole-document payloads.
 *   The prompt (omni.ts) carries the real brief-not-content rule; this is the
 *   backstop, not the primary control.
 * - `target` may be absent or null (normalized to absent). When present it
 *   must be an object with a non-empty `description` string and a `heading`
 *   that is a string or null (absent normalized to null).
 * - `verbatim` may be absent or null; when present it must be a non-empty
 *   string (the user dictated exact words — an empty dictation is a mistake).
 * - `constraints` may be absent or null (normalized to absent); when present
 *   it must be an array of non-empty strings.
 * - `frame_relevant` may be absent; when present it must be a boolean.
 * - **Unknown extra properties are IGNORED, not rejected.** The §5 field set
 *   is the contract to the worker and extras never travel past this
 *   validator; E1 measured 11/11 schema-valid native emissions with no junk
 *   fields, so spending the turn's single repair retry on a harmless extra
 *   would buy nothing.
 */

import type { Directive } from '../types'
import { isRecord } from './utils'

export type DirectiveValidation =
  | { valid: true; directive: Directive }
  | { valid: false; error: string }

/** The §5 closed task enum. */
export const DIRECTIVE_TASKS = ['create', 'insert', 'edit', 'remove', 'extract'] as const

export type DirectiveTask = (typeof DIRECTIVE_TASKS)[number]

/**
 * Length heuristic for the whole-content-in-instruction drift (E1 T13).
 * Documented above; the system prompt carries the real rule.
 */
export const INSTRUCTION_MAX_CHARS = 600

function isDirectiveTask(value: unknown): value is DirectiveTask {
  return typeof value === 'string' && (DIRECTIVE_TASKS as readonly string[]).includes(value)
}

/**
 * Validate an unknown parsed value (typically a native tool-call's arguments
 * object) against the §5 schema. Pure; no I/O. Returns the first-validation
 * error string when invalid — the error is written to be appended to the
 * repair retry verbatim.
 */
export function validateDirective(raw: unknown): DirectiveValidation {
  if (!isRecord(raw)) {
    return { valid: false, error: 'the directive arguments are not a JSON object' }
  }

  const errors: string[] = []

  if (!isDirectiveTask(raw.task)) {
    errors.push(
      `task must be one of create|insert|edit|remove|extract (got ${JSON.stringify(raw.task) ?? 'missing'})`,
    )
  }

  const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim() : ''
  if (!instruction) {
    errors.push('instruction must be a non-empty string')
  } else if (instruction.length > INSTRUCTION_MAX_CHARS) {
    errors.push(
      `instruction is ${instruction.length} characters — it reads as the content itself, not a brief. ` +
        `Pack everything the user specified about the content (sections named, values given, tone asked for) ` +
        `into at most ${INSTRUCTION_MAX_CHARS} characters; authoring the content is the worker's job`,
    )
  }

  let target: Directive['target']
  if (raw.target === undefined || raw.target === null) {
    target = undefined
  } else if (!isRecord(raw.target)) {
    errors.push('target must be an object like {"description": …, "heading": …} or absent')
  } else {
    const description =
      typeof raw.target.description === 'string' ? raw.target.description.trim() : ''
    if (!description) {
      errors.push('target.description must be a non-empty string')
    }
    const heading = raw.target.heading
    if (heading !== undefined && heading !== null && typeof heading !== 'string') {
      errors.push('target.heading must be a string or null')
    }
    if (description && (heading === undefined || heading === null || typeof heading === 'string')) {
      target = {
        description,
        heading: typeof heading === 'string' ? heading : null,
      }
    }
  }

  let verbatim: string | null | undefined
  if (raw.verbatim === undefined || raw.verbatim === null) {
    verbatim = raw.verbatim === null ? null : undefined
  } else if (typeof raw.verbatim !== 'string' || !raw.verbatim.trim()) {
    errors.push('verbatim must be non-empty exact dictated text or null')
  } else {
    verbatim = raw.verbatim
  }

  let constraints: string[] | undefined
  if (raw.constraints === undefined || raw.constraints === null) {
    constraints = undefined
  } else if (!Array.isArray(raw.constraints) || raw.constraints.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    errors.push('constraints must be an array of non-empty strings or absent')
  } else {
    constraints = raw.constraints
  }

  let frameRelevant: boolean | undefined
  if (raw.frame_relevant !== undefined && typeof raw.frame_relevant !== 'boolean') {
    errors.push('frame_relevant must be a boolean')
  } else {
    frameRelevant = raw.frame_relevant
  }

  if (errors.length > 0 || !isDirectiveTask(raw.task) || !instruction) {
    return { valid: false, error: errors.join('; ') || 'the directive is not valid' }
  }

  const directive: Directive = { task: raw.task, instruction }
  if (target) directive.target = target
  if (verbatim !== undefined) directive.verbatim = verbatim
  if (constraints) directive.constraints = constraints
  if (frameRelevant !== undefined) directive.frame_relevant = frameRelevant
  return { valid: true, directive }
}

/**
 * The user-role message appended for the ONE repair retry (design.md §5:
 * schema error appended, single retry). The message follows the E1 run-3
 * history discipline: the failed attempt persists as an assistant tool_call
 * plus a tool-role "Execution failed" result (assembled in omni.ts), and this
 * user message carries the schema error — nothing harness-authored ever
 * enters the assistant channel.
 */
export function buildDirectiveRepairMessage(error: string): string {
  return [
    `That delegate_edit call was rejected: ${error}`,
    'Call delegate_edit again with a corrected directive.',
    'The instruction is a brief, not the content: everything the user specified about it ' +
      '(sections named, values given, exact dictated wording, tone asked for), with references ' +
      'like "the same for Q4" resolved from the conversation — never the authored content itself.',
  ].join(' ')
}
