import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeHealth } from '../types'
import { probeRuntime } from '../lib/bridge'

export interface RuntimeHealthApi {
  runtimeHealth: RuntimeHealth | null
  /** Latest health, readable synchronously by callbacks that outlive a render. */
  healthRef: { current: RuntimeHealth | null }
  refreshRuntime: () => Promise<void>
}

/**
 * Runtime health: probed once on mount, then every 10 s. The ref mirrors the
 * state so synchronous readers (TTS endpoint check, mic arm, model switch)
 * see the latest probe without waiting for a render.
 */
export function useRuntimeHealth(): RuntimeHealthApi {
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null)
  const healthRef = useRef<RuntimeHealth | null>(null)

  const refreshRuntime = useCallback(async () => {
    const health = await probeRuntime()
    healthRef.current = health
    setRuntimeHealth(health)
  }, [])

  useEffect(() => {
    void refreshRuntime()
    const timer = window.setInterval(() => {
      void refreshRuntime()
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [refreshRuntime])

  return { runtimeHealth, healthRef, refreshRuntime }
}
