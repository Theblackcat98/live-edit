import { useCallback, useEffect, useRef, useState } from 'react'
import type { Toast } from '../types'

export interface ToastsApi {
  toast: Toast | null
  notify: (title: string, detail?: string, tone?: Toast['tone']) => void
  dismissToast: () => void
}

/**
 * The transcript toast queue: one toast at a time, replaced by the next
 * notify, auto-dismissed after 4.6 s. Owns its timer so the orchestrator
 * does not have to clear it on unmount.
 */
export function useToasts(): ToastsApi {
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const toastCounter = useRef(0)

  useEffect(() => {
    if (!toast) return
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4600)
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    }
  }, [toast])

  const notify = useCallback(
    (title: string, detail?: string, tone: Toast['tone'] = 'neutral') => {
      toastCounter.current += 1
      setToast({ id: toastCounter.current, title, detail, tone })
    },
    [],
  )

  const dismissToast = useCallback(() => setToast(null), [])

  return { toast, notify, dismissToast }
}
