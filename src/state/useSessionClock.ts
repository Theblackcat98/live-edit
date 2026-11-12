import { useEffect, useState } from 'react'

export interface SessionClockApi {
  /** Whole seconds since the session mounted. */
  elapsedSeconds: number
  /** Wall clock, ticked once a second for relative message times. */
  nowTick: number
}

/** One-second session clock: elapsed time plus a wall-clock tick. */
export function useSessionClock(): SessionClockApi {
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [nowTick, setNowTick] = useState(Date.now())
  const [sessionStart] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - sessionStart) / 1000))
      setNowTick(Date.now())
    }, 1000)
    setElapsedSeconds(Math.floor((Date.now() - sessionStart) / 1000))
    return () => window.clearInterval(timer)
  }, [sessionStart])

  return { elapsedSeconds, nowTick }
}
