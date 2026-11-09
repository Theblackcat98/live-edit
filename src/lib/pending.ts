import type {
  Directive,
  ExecutionResult,
  PendingEdit,
  RejectedTraceRecord,
  SpanTarget,
  WorkerCall,
} from '../types'
import { noteHash } from './doc'
import { runHardGates, type GateFailure } from './gates'
import { executeTool } from './tools'

/**
 * Pending edits (design.md §9; architecture-refactor.md Phase 5).
 *
 * A tool call the semantic check rejected — but which passes every
 * deterministic hard gate — is not thrown away and not executed. It becomes
 * a first-class pending edit: stored with the diff rendered against the
 * note version it was authored against, and adjudicated by the user.
 *
 * Built ahead of Phases 2–4 (owner-directed backwards order, 2026-11-09):
 * the legacy pipeline's critic-rejection path is the producer seam today.
 * When Phase 4 lands `d1check.ts`, its disapproved/unavailable verdicts
 * call `createPendingEdit` with the real `D1CheckResult` and a real Omni
 * directive; nothing in this module changes.
 *
 * Adjudication rules (design.md §8/§9):
 * - ✓ re-runs the hard gates against the *current* note. A hash mismatch
 *   or a gate failure resolves the edit as `stale` — it is never offered
 *   as a user choice and never force-applied past a hard gate.
 * - ✗ resolves it as `discarded` and appends a record to the
 *   rejected-traces export, like any other stopped call.
 * - A pending edit modifies nothing — not the note, the snapshot stack,
 *   or the undo chain — until ✓ applies it.
 */

let pendingCounter = 0

export function makePendingId(): string {
  pendingCounter += 1
  return `pending-${Date.now().toString(36)}-${pendingCounter.toString(36)}`
}

/** The directive a legacy (pre-Omni) turn can honestly claim: the user's command *is* the brief. */
export function directiveFromCommand(command: string, call: WorkerCall): Directive {
  const task: Directive['task'] =
    call.name === 'add_text'
      ? 'insert'
      : call.name === 'remove_text'
        ? 'remove'
        : call.name === 'extract_visual_to_note'
          ? 'extract'
          : 'edit'
  return { task, instruction: command }
}

/**
 * Whether a critic rejection may become a pending edit. Only semantic
 * rejections are adjudicable: if any hard gate fails, the call is refused
 * outright and the user is never offered a ✓/✗ choice on it (design.md §8).
 */
export function isPendableRejection(note: string, call: WorkerCall, span?: SpanTarget): boolean {
  return runHardGates(note, call, span).pass
}

export interface PendingProposal {
  command: string
  call: WorkerCall
  /** The directive that produced the call; omit on the legacy path (derived from the command). */
  directive?: Directive
  d1: PendingEdit['d1']
}

/**
 * Build a pending edit from a rejected call, or return null when the call
 * cannot even be previewed — the caller then keeps the plain rejection.
 * The diff is rendered by dry-running the engine against the note the call
 * was authored against; the note itself is not modified.
 */
export function createPendingEdit(note: string, proposal: PendingProposal): PendingEdit | null {
  const preview = executeTool(note, proposal.call)
  if (!preview.ok || !preview.diff) return null
  return {
    id: makePendingId(),
    createdAt: Date.now(),
    directive: proposal.directive ?? directiveFromCommand(proposal.command, proposal.call),
    call: proposal.call,
    diff: preview.diff,
    noteHash: noteHash(note),
    d1: proposal.d1,
    status: 'pending',
  }
}

export type ApplyOutcome =
  | { kind: 'applied'; execution: ExecutionResult }
  | { kind: 'stale'; failures: GateFailure[]; reason: string }

/**
 * Attempt to apply a pending edit to the current note. Order matters:
 * staleness (hash) first, then the hard gates re-run, then the engine —
 * which enforces the same caps itself, so a gate bypass is impossible
 * even if this pre-check and the engine ever drift.
 */
export function applyPendingEdit(note: string, pending: PendingEdit): ApplyOutcome {
  if (noteHash(note) !== pending.noteHash) {
    return {
      kind: 'stale',
      failures: [{ gate: 'staleness', detail: 'The note changed after this edit was proposed.' }],
      reason: 'The note changed after this edit was proposed, so its anchors may have drifted.',
    }
  }
  const gates = runHardGates(note, pending.call)
  if (!gates.pass) {
    return {
      kind: 'stale',
      failures: gates.failures,
      reason: `Hard gates no longer pass: ${gates.failures.map((failure) => failure.detail).join(' ')}`,
    }
  }
  const execution = executeTool(note, pending.call)
  if (!execution.ok || !execution.diff) {
    return {
      kind: 'stale',
      failures: [{ gate: 'execution', detail: execution.message }],
      reason: execution.message,
    }
  }
  return { kind: 'applied', execution }
}

/**
 * The rejected-traces record for a user-resolved pending edit (discarded,
 * or stale at adjudication). Grounding is honestly marked
 * `pending-adjudication`: the user, not a grounding pass, made this call.
 */
export function pendingToRejectedRecord(pending: PendingEdit, reason: string): RejectedTraceRecord {
  return {
    at: Date.now(),
    command: pending.directive.instruction,
    route: { tool: pending.call.name, provenance: 'pending edit adjudication' },
    spanCandidates: [],
    grounding: { source: 'pending-adjudication' },
    workerXml: pending.call.xml,
    critic: { verdict: 'rejected', reason, pCorrect: pending.d1.noul },
  }
}

/** Pending edits awaiting adjudication, oldest first (the FIFO the card list and voice targeting use). */
export function unresolvedPendings(pendings: PendingEdit[]): PendingEdit[] {
  return pendings.filter((pending) => pending.status === 'pending')
}
