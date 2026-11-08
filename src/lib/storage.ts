/**
 * Persistent workspace state around localStorage key 'liquidscribe.workspace.v1'.
 * Best-effort only: every access is guarded, corrupt or absent state returns
 * null (the app seeds fresh), and quota failures are swallowed silently.
 */

import type { Message, RejectedTraceRecord, Snapshot, Trace } from '../types'

const STORAGE_KEY = 'liquidscribe.workspace.v1'
const SCHEMA_VERSION = 1
const MAX_PERSISTED_RUNS = 12

export interface PersistedWorkspace {
  version: 1
  note: string
  snapshots: Snapshot[]
  messages: Message[]
  runs: Trace[]
  rejectedTraces: RejectedTraceRecord[]
}

interface StoredShape {
  version?: unknown
  note?: unknown
  snapshots?: unknown
  messages?: unknown
  runs?: unknown
  rejectedTraces?: unknown
}

export function loadWorkspaceState(): PersistedWorkspace | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredShape
    if (parsed.version !== SCHEMA_VERSION || typeof parsed.note !== 'string') return null
    return {
      version: 1,
      note: parsed.note,
      snapshots: Array.isArray(parsed.snapshots) ? (parsed.snapshots as Snapshot[]) : [],
      messages: Array.isArray(parsed.messages) ? (parsed.messages as Message[]) : [],
      runs: Array.isArray(parsed.runs) ? (parsed.runs as Trace[]) : [],
      rejectedTraces: Array.isArray(parsed.rejectedTraces)
        ? (parsed.rejectedTraces as RejectedTraceRecord[])
        : [],
    }
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
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // QuotaExceededError or a blocked store — persistence is best-effort.
  }
}
