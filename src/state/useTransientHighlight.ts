import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ExecutionDiff } from '../types'

export interface TransientHighlightApi {
  /** Execution diff highlighted on the note. */
  diff: ExecutionDiff | null
  setDiff: Dispatch<SetStateAction<ExecutionDiff | null>>
  /** Drop the highlight immediately (a turn is starting). */
  clearTransientHighlights: () => void
  /** Fade the diff out after a successful execution. */
  scheduleHighlightClear: () => void
}

/** The note's transient execution-diff highlight and its clear timer. */
export function useTransientHighlight(): TransientHighlightApi {
  const [diff, setDiff] = useState<ExecutionDiff | null>(null)
  const highlightTimerRef = useRef<number | null>(null)

  const clearTransientHighlights = useCallback(() => {
    if (highlightTimerRef.current) {
      window.clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = null
    }
  }, [])

  const scheduleHighlightClear = useCallback(() => {
    clearTransientHighlights()
    highlightTimerRef.current = window.setTimeout(() => {
      setDiff(null)
    }, 7200)
  }, [clearTransientHighlights])

  useEffect(() => clearTransientHighlights, [clearTransientHighlights])

  return { diff, setDiff, clearTransientHighlights, scheduleHighlightClear }
}
