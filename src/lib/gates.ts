import type { SpanTarget, ToolDefinition, WorkerCall } from '../types'
import { TOOL_DEFS } from '../data/tools'
import { normalizeWhitespace, splitLines } from './doc'

/**
 * Hard gates (design.md §8): the deterministic, non-overridable checks a
 * worker call must pass before anything else (d1 check, execution, pending
 * adjudication) may consider it. Extracted verbatim from the deterministic
 * checks that lived inline in `critique()` (architecture-refactor.md §5.2), so
 * the old path behaves identically while the new pipeline gets the same rules
 * as pure, individually testable functions.
 *
 * Blast-radius constants mirror the engine-level enforcement in `tools.ts`
 * (`executeTool` refuses the same calls itself — audit TD-44, P1 step 3), so
 * the pre-check and the engine cannot drift apart silently. Keep the two
 * definitions in lockstep; `tools.ts` is the engine twin of this file.
 */

/** One gate check outcome. `gate` names the check (the critic's check label for the checks critique consumes). */
export interface GateCheckResult {
  gate: string
  pass: boolean
  detail: string
}

/** A failed gate, as reported by runHardGates. */
export interface GateFailure {
  gate: string
  detail: string
}

/** Structured result of composing all hard gates. */
export interface HardGateResult {
  pass: boolean
  failures: GateFailure[]
}

/**
 * Engine twin: `removalCapFor` in tools.ts. A removal of half the note (or 9+
 * lines on small notes) is destructive no matter who asked.
 */
function removalCapFor(lineCount: number): number {
  return Math.max(9, Math.floor(lineCount * 0.5))
}

/**
 * Engine twin: `EDIT_RETENTION_RATIO` in tools.ts. A replacement keeping under
 * 30% of the target's length guts it, at any target size — the old
 * 90-character floor let short-target gutting through (audit TD-44).
 */
const EDIT_RETENTION_RATIO = 0.3

/**
 * Schema validity gate (design.md §8): known tool, all required parameters
 * present, non-empty, and typed — mirroring TOOL_DEFS plus the guards
 * `executeTool` itself applies (integer `start_line`/`end_line`, non-empty
 * insert/extract payloads). Enum-valued params are deliberately not gated
 * here: `executeTool` treats an unrecognised value as its documented default
 * (e.g. `position` falls through to append), and the gate must not be stricter
 * than the engine about what it refuses.
 *
 * Returns one result per violation (a call can be wrong in several ways), or
 * a single passing result.
 */
export function checkSchema(call: WorkerCall): GateCheckResult[] {
  const definition = (TOOL_DEFS as readonly ToolDefinition[]).find((tool) => tool.name === call.name)
  if (!definition) {
    return [{ gate: 'schema', pass: false, detail: `Unknown tool: ${call.name}.` }]
  }
  const results: GateCheckResult[] = []
  for (const param of definition.params) {
    if (!param.required) continue
    const value = call.params[param.name]
    if (value === undefined || value.trim() === '') {
      results.push({
        gate: 'schema',
        pass: false,
        detail: `Missing required parameter: ${param.name}.`,
      })
      continue
    }
    if (param.type === 'integer' && !Number.isInteger(Number(value))) {
      results.push({
        gate: 'schema',
        pass: false,
        detail: `Parameter ${param.name} must be an integer.`,
      })
    }
  }
  if (results.length === 0) {
    return [{ gate: 'schema', pass: true, detail: `${call.name} parameters are valid.` }]
  }
  return results
}

/**
 * Range-bounds gate (design.md §8): `1 ≤ start_line ≤ end_line ≤ line_count`
 * for the span tools (`edit_text`, `remove_text`). Other tools have no range —
 * null means "no check applies".
 */
export function checkBounds(note: string, call: WorkerCall): GateCheckResult | null {
  if (call.name !== 'edit_text' && call.name !== 'remove_text') return null
  const start = Number(call.params.start_line)
  const end = Number(call.params.end_line)
  const lines = splitLines(note)
  const valid =
    Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= lines.length
  return {
    gate: 'range_in_bounds',
    pass: valid,
    detail: valid
      ? `Lines ${start}–${end} exist (${lines.length} total).`
      : 'Proposed range is outside the note.',
  }
}

/**
 * Anchor-exactness gate (design.md §8): the call's anchor (`old_text_anchor`
 * for `edit_text`, `target_excerpt` for `remove_text`) must match the current
 * lines at the stated range, whitespace-normalized.
 *
 * `expected` overrides the comparison source: the supervisor path passes its
 * grounded span excerpt so a self-consistent invented range (worker invents a
 * range and copies its own text) still fails — today's span-validated
 * semantics, audit TD-01. Without it the note's own lines at the range are the
 * source (the worker-grounds-itself world of design.md §8). Other tools have
 * no range anchor — null means "no check applies".
 */
export function checkAnchor(note: string, call: WorkerCall, expected?: string): GateCheckResult | null {
  if (call.name !== 'edit_text' && call.name !== 'remove_text') return null
  const lines = splitLines(note)
  const start = Number(call.params.start_line)
  const end = Number(call.params.end_line)
  const current = lines.slice(start - 1, end).join('\n')
  const anchor = call.name === 'edit_text' ? call.params.old_text_anchor : call.params.target_excerpt
  const source = expected !== undefined ? expected : current
  const pass = normalizeWhitespace(source) === normalizeWhitespace(anchor)
  return {
    gate: 'anchor_exact',
    pass,
    detail: pass
      ? expected !== undefined
        ? 'old_text_anchor matches the grounded span exactly.'
        : 'old_text_anchor matches the current lines exactly.'
      : 'Anchor drifted from the grounded span.',
  }
}

/**
 * Blast-radius gate (design.md §8, audit TD-44): a `remove_text` beyond the
 * removal cap, or an `edit_text` whose replacement collapses the target to
 * under 30% of its length, fails. Constants are the engine twins of the
 * enforcement inside `executeTool` (tools.ts) — see the file-header comment.
 * Other tools cannot delete — null means "no check applies".
 */
export function checkBlastRadius(note: string, call: WorkerCall): GateCheckResult | null {
  const lines = splitLines(note)
  if (call.name === 'remove_text') {
    const start = Number(call.params.start_line)
    const end = Number(call.params.end_line)
    const removed = end - start + 1
    const pass = removed < removalCapFor(lines.length)
    return {
      gate: 'destructive_safety',
      pass,
      detail: pass
        ? `${removed} line${removed === 1 ? '' : 's'} removed; below blast-radius limit.`
        : 'Removal exceeds the blast-radius limit.',
    }
  }
  if (call.name === 'edit_text') {
    const start = Number(call.params.start_line)
    const end = Number(call.params.end_line)
    const current = lines.slice(start - 1, end).join('\n')
    const replacementLength = (call.params.new_text ?? '').trim().length
    const pass = replacementLength >= current.length * EDIT_RETENTION_RATIO
    return {
      gate: 'blast_radius',
      pass,
      detail: pass
        ? `Replacement retains enough of the target (${replacementLength} of ${current.length} characters).`
        : 'Replacement collapses the grounded target. Ask for a narrower target.',
    }
  }
  return null
}

/**
 * Compose all four hard gates (design.md §8). Composition policy:
 * schema first — a call with no known tool or missing required parameters
 * cannot be meaningfully bounds- or anchor-checked, so the range-dependent
 * gates are skipped; then bounds — anchor and blast radius read the note
 * through the call's range, so they run only against an in-bounds range (the
 * same short-circuit the critic path has always used).
 *
 * `span` (when a caller has a grounded span, as the supervisor path does)
 * makes the anchor gate compare against the span excerpt — audit TD-01
 * semantics — rather than the call's own range.
 */
export function runHardGates(note: string, call: WorkerCall, span?: SpanTarget): HardGateResult {
  const checks: GateCheckResult[] = [...checkSchema(call)]
  if (checks.every((check) => check.pass)) {
    const bounds = checkBounds(note, call)
    if (bounds) {
      checks.push(bounds)
      if (bounds.pass) {
        const anchor = checkAnchor(note, call, span?.excerpt)
        if (anchor) checks.push(anchor)
        const blast = checkBlastRadius(note, call)
        if (blast) checks.push(blast)
      }
    }
  }
  const failures: GateFailure[] = checks
    .filter((check) => !check.pass)
    .map((check) => ({ gate: check.gate, detail: check.detail }))
  return { pass: failures.length === 0, failures }
}
