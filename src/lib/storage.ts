/**
 * Persistent workspace state around localStorage key 'liquidscribe.workspace.v1'.
 * Best-effort only: every access is guarded, corrupt or absent state returns
 * null (the app seeds fresh), and quota failures are swallowed silently.
 *
 * Schema v2 (architecture-refactor.md §9.2, decision D3) adds `pendingEdits`.
 * Migration is read-side only: a v1 payload loads with `pendingEdits: []` while
 * note/snapshots/messages/runs/rejectedTraces carry over untouched; the next
 * save writes v2. Unknown, absent or mistyped versions are still rejected
 * outright (the app seeds fresh) — the loader never guesses.
 */

import type { Message, PendingEdit, RejectedTraceRecord, Snapshot, Trace } from '../types'

const STORAGE_KEY = 'liquidscribe.workspace.v1'
export const SCHEMA_VERSION = 2
const MAX_PERSISTED_RUNS = 12

export interface PersistedWorkspace {
  version: 2
  note: string
  snapshots: Snapshot[]
  messages: Message[]
  runs: Trace[]
  rejectedTraces: RejectedTraceRecord[]
  /** Pending edits awaiting (or resolved by) user adjudication — design.md §9. */
  pendingEdits: PendingEdit[]
}

interface StoredShape {
  version?: unknown
  note?: unknown
  snapshots?: unknown
  messages?: unknown
  runs?: unknown
  rejectedTraces?: unknown
  pendingEdits?: unknown
}

export function loadWorkspaceState(): PersistedWorkspace | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredShape
    // Accept the current schema and the immediately previous one (D3 migration);
    // everything else — unknown, absent, mistyped — seeds fresh, as before.
    const knownVersion = parsed.version === 1 || parsed.version === SCHEMA_VERSION
    if (!knownVersion || typeof parsed.note !== 'string') return null
    return {
      // Whatever was on disk, the normalized shape in memory is current-schema;
      // the next save persists v2.
      version: SCHEMA_VERSION,
      note: parsed.note,
      snapshots: Array.isArray(parsed.snapshots) ? (parsed.snapshots as Snapshot[]) : [],
      messages: Array.isArray(parsed.messages) ? (parsed.messages as Message[]) : [],
      runs: Array.isArray(parsed.runs) ? (parsed.runs as Trace[]) : [],
      rejectedTraces: Array.isArray(parsed.rejectedTraces)
        ? (parsed.rejectedTraces as RejectedTraceRecord[])
        : [],
      // v1 payloads carry none; a v2 payload with an absent or non-array list
      // loads as [] rather than throwing (same defensive discipline as above).
      pendingEdits: Array.isArray(parsed.pendingEdits) ? (parsed.pendingEdits as PendingEdit[]) : [],
    }
  } catch {
    return null
  }
}

/**
 * Persists `pendingEdits` verbatim. The contract (D3): the caller hands over an
 * already-capped list — pending.ts's toStorable keeps the 10 most recent
 * non-resolved — and storage does no filtering of its own. Until the Phase-5
 * wiring passes real pendings, call sites omit the field and saves carry
 * `pendingEdits: []`, which is the correct v2 shape for a workspace with no
 * pending edits.
 */
export function saveWorkspaceState(state: {
  note: string
  snapshots: Snapshot[]
  messages: Message[]
  runs: Trace[]
  rejectedTraces: RejectedTraceRecord[]
  pendingEdits?: PendingEdit[]
}): void {
  try {
    const payload: PersistedWorkspace = {
      version: SCHEMA_VERSION,
      note: state.note,
      snapshots: state.snapshots,
      messages: state.messages,
      // Traces are fat — keep only the most recent window.
      runs: state.runs.slice(-MAX_PERSISTED_RUNS),
      rejectedTraces: state.rejectedTraces,
      pendingEdits: state.pendingEdits ?? [],
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // QuotaExceededError or a blocked store — persistence is best-effort.
  }
}
