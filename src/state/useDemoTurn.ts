import { useCallback, useRef, useState } from 'react'
import type { Toast } from '../types'
import { DEMO_SEQUENCE } from '../data/note'
import { sleep } from '../lib/utils'
import type { SubmitCommand } from './useWorkspaceVoice'

interface DemoTurnArgs {
  busyRef: { current: boolean }
  notify: (title: string, detail?: string, tone?: Toast['tone']) => void
  /** Latest submitCommand; the demo runs turns like any other caller. */
  submitRef: { current: SubmitCommand }
}

export interface DemoTurnApi {
  demoRunning: boolean
  runDemo: () => Promise<void>
}

/**
 * The canned demo sequence: runs each scripted turn in order, 650 ms apart,
 * and stops after the current verified call when toggled off.
 */
export function useDemoTurn({ busyRef, notify, submitRef }: DemoTurnArgs): DemoTurnApi {
  const [demoRunning, setDemoRunning] = useState(false)
  const demoRunningRef = useRef(false)
  const demoStopRef = useRef(false)

  const runDemo = useCallback(async () => {
    if (demoRunningRef.current) {
      demoStopRef.current = true
      setDemoRunning(false)
      notify('Demo stopping', 'The current verified call will finish first.')
      return
    }
    if (busyRef.current) {
      notify('Still working', 'Wait for the current turn to finish before starting the demo.', 'neutral')
      return
    }
    demoStopRef.current = false
    demoRunningRef.current = true
    setDemoRunning(true)
    for (const step of DEMO_SEQUENCE) {
      if (demoStopRef.current) break
      await submitRef.current(step.command, step.source)
      await sleep(650)
    }
    demoStopRef.current = false
    demoRunningRef.current = false
    setDemoRunning(false)
  }, [busyRef, notify, submitRef])

  return { demoRunning, runDemo }
}
