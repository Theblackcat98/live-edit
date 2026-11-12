import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { RejectedTraceRecord, Trace } from '../types'
import type { PersistedWorkspace } from '../lib/storage'

interface TracesArgs {
  persisted: PersistedWorkspace | null
}

export interface WorkspaceTracesApi {
  trace: Trace | null
  setTrace: Dispatch<SetStateAction<Trace | null>>
  /** Latest trace, readable synchronously by callbacks that outlive a render. */
  traceRef: { current: Trace | null }
  runs: Trace[]
  setRuns: Dispatch<SetStateAction<Trace[]>>
  /** Completed runs, kept current by the turn pipeline for the next turn's memory. */
  runsRef: { current: Trace[] }
  rejectedTraces: RejectedTraceRecord[]
  setRejectedTraces: Dispatch<SetStateAction<RejectedTraceRecord[]>>
  selectedTrace: Trace | null
  traceOpen: boolean
  openTrace: (id?: string) => void
  closeTrace: () => void
  /** Clear the conversation's traces (resetChat): live trace, run list, selection. */
  resetTraces: () => void
}

/**
 * Trace state for the drawer: the running turn's trace, the completed run
 * list, the rejected-call log, and the selected/open drawer.
 */
export function useWorkspaceTraces({ persisted }: TracesArgs): WorkspaceTracesApi {
  const [trace, setTrace] = useState<Trace | null>(null)
  const [runs, setRuns] = useState<Trace[]>(persisted?.runs ?? [])
  const [rejectedTraces, setRejectedTraces] = useState<RejectedTraceRecord[]>(
    persisted?.rejectedTraces ?? [],
  )
  const [traceOpen, setTraceOpen] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  const runsRef = useRef<Trace[]>(runs)
  const traceRef = useRef<Trace | null>(null)

  useEffect(() => {
    traceRef.current = trace
  }, [trace])

  const openTrace = useCallback((id?: string) => {
    // After a reload there is no live trace, but persisted runs are still
    // inspectable — fall back to the newest one instead of an empty drawer.
    setSelectedTraceId(id ?? traceRef.current?.id ?? runsRef.current[0]?.id ?? null)
    setTraceOpen(true)
  }, [])

  const closeTrace = useCallback(() => setTraceOpen(false), [])

  const selectedTrace = useMemo(() => {
    if (selectedTraceId) {
      return runs.find((run) => run.id === selectedTraceId) ?? (trace?.id === selectedTraceId ? trace : null)
    }
    return trace ?? runs[0] ?? null
  }, [runs, selectedTraceId, trace])

  const resetTraces = useCallback(() => {
    runsRef.current = []
    setRuns([])
    setSelectedTraceId(null)
    setTrace(null)
  }, [])

  return {
    trace,
    setTrace,
    traceRef,
    runs,
    setRuns,
    runsRef,
    rejectedTraces,
    setRejectedTraces,
    selectedTrace,
    traceOpen,
    openTrace,
    closeTrace,
    resetTraces,
  }
}
