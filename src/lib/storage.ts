/**
 * Persistent workspace state around localStorage key 'liquidscribe.workspace.v1'.
 * Best-effort only: every access is guarded, corrupt or absent state returns
 * null (the app seeds fresh), and quota failures are swallowed silently.
 *
 * Schema v2 (Phase 5) adds `pendingEdits`. v1 payloads migrate in
 * `parseWorkspaceState` with an empty pending list — the migration is a
 * pure function so it is unit-testable without a DOM.
 */

import type { Message, PendingEdit, RejectedTraceRecord, Snapshot, Trace } from '../types'

const STORAGE_KEY = 'liquidscribe.workspace.v1'
const SCHEMA_VERSION = 2
const MAX_PERSISTED_RUNS = 12
const MAX_PERSISTED_PENDINGS = 10

export interface PersistedWorkspace {
  version: 2
  note: string
  snapshots: Snapshot[]
  messages: Message[]
  runs: Trace[]
  rejectedTraces: RejectedTraceRecord[]
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

/**
 * Parse (and, for v1, migrate) a stored payload. Returns null for anything
 * unrecognised — a newer schema, a corrupt blob, a missing note — so the
 * caller seeds fresh rather than guessing.
 */
export function parseWorkspaceState(raw: string | null): PersistedWorkspace | null {
  if (!raw) return null
  let parsed: StoredShape
  try {
    parsed = JSON.parse(raw) as StoredShape
  } catch {
    return null
  }
  if (typeof parsed.note !== 'string') return null
  if (parsed.version !== 1 && parsed.version !== SCHEMA_VERSION) return null
  return {
    version: 2,
    note: parsed.note,
    snapshots: Array.isArray(parsed.snapshots) ? (parsed.snapshots as Snapshot[]) : [],
    messages: Array.isArray(parsed.messages) ? (parsed.messages as Message[]) : [],
    runs: Array.isArray(parsed.runs) ? (parsed.runs as Trace[]) : [],
    rejectedTraces: Array.isArray(parsed.rejectedTraces)
      ? (parsed.rejectedTraces as RejectedTraceRecord[])
      : [],
    // v1 predates pending edits; v2 payloads carry them. Unresolved edits
    // persist across reloads (design.md §9 / decision D3).
    pendingEdits: Array.isArray(parsed.pendingEdits) ? (parsed.pendingEdits as PendingEdit[]) : [],
  }
}

export function loadWorkspaceState(): PersistedWorkspace | null {
  try {
    return parseWorkspaceState(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export function saveWorkspaceState(state: {
  note: string
  snapshots: Snapshot[]
  messages: Message[]
  runs: Trace[]
  rejectedTraces: RejectedTraceRecord[]
  pendingEdits: PendingEdit[]
}): void {
  try {
    const unresolved = state.pendingEdits.filter((pending) => pending.status === 'pending')
    const resolved = state.pendingEdits.filter((pending) => pending.status !== 'pending')
    const payload: PersistedWorkspace = {
      version: SCHEMA_VERSION,
      note: state.note,
      snapshots: state.snapshots,
      messages: state.messages,
      // Traces are fat — keep only the most recent window.
      runs: state.runs.slice(-MAX_PERSISTED_RUNS),
      rejectedTraces: state.rejectedTraces,
      // Every unresolved edit persists; resolved ones are history, capped.
      pendingEdits: [...unresolved, ...resolved.slice(-MAX_PERSISTED_PENDINGS)],
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // QuotaExceededError or a blocked store — persistence is best-effort.
  }
}
