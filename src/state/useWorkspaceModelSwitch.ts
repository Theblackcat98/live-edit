import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message, RuntimeHealth, Toast } from '../types'
import { ENDPOINTS, endpointUp } from '../lib/bridge'
import { loadRunMode, saveRunMode, type RunMode } from '../lib/runmode'
import { modeDef } from '../lib/modes'
import { managerStart, managerStatus, managerStop } from '../lib/modelManager'
import { managerNameFor, planModelSwitch, type ModelSwitchPlan } from '../lib/modelPlan'
import { sleep } from '../lib/utils'

type AddMessage = (message: Omit<Message, 'id' | 'at'> & { at?: number; id?: string }) => string

interface ModelSwitchArgs {
  notify: (title: string, detail?: string, tone?: Toast['tone']) => void
  addMessage: AddMessage
  busyRef: { current: boolean }
  healthRef: { current: RuntimeHealth | null }
  /** Probe health and publish it (the runtime-health hook's refresh). */
  refreshRuntime: () => Promise<void>
  /** Hands-free toggle mirror, owned by the speech hook. */
  micOnRef: { current: boolean }
  /** Latest stopMic: late-bound because the speech hook is declared after this one. */
  stopMicRef: { current: () => void }
}

export interface WorkspaceModelSwitchApi {
  /** Active run mode: which local models serve chat and edits. */
  mode: RunMode
  /** Latest mode, readable synchronously by callbacks that outlive a render. */
  modeRef: { current: RunMode }
  pendingSwitch: ModelSwitchPlan | null
  switchingModels: boolean
  /** Switch mode, asking first when the model roster differs. */
  setMode: (mode: RunMode) => void
  /** Apply a mode immediately: persist, announce, stop an impossible mic. */
  applyMode: (next: RunMode) => void
  confirmPendingSwitch: (stopSpares: boolean) => void
  cancelPendingSwitch: () => void
}

/**
 * The run-mode switch: persisted, announced in the transcript, blocked while
 * a turn runs, and — when the target roster differs from what is loaded —
 * routed through the model-manager dialog first.
 *
 * The hands-free mic belongs to the speech hook, which is declared after
 * this one, so the stop path is late-bound through `stopMicRef`; the mic
 * mirror comes in as a ref for the same reason.
 */
export function useWorkspaceModelSwitch({
  notify,
  addMessage,
  busyRef,
  healthRef,
  refreshRuntime,
  micOnRef,
  stopMicRef,
}: ModelSwitchArgs): WorkspaceModelSwitchApi {
  const [mode, setModeState] = useState<RunMode>(() => loadRunMode())
  const [pendingSwitch, setPendingSwitch] = useState<ModelSwitchPlan | null>(null)
  const [switchingModels, setSwitchingModels] = useState(false)
  const modeRef = useRef<RunMode>(mode)

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  /** The mode-switch application itself: persist, announce, honest mic stop. */
  const applyMode = useCallback(
    (next: RunMode) => {
      modeRef.current = next
      setModeState(next)
      saveRunMode(next)
      const info = modeDef(next).info
      addMessage({
        role: 'system',
        kind: 'notice',
        text: `Mode: ${info.short} — ${info.description}`,
      })
      notify(`Run mode: ${info.short}`, info.description, 'neutral')
      // Hands-free listening needs an Omni-architecture speech server. If the
      // new mode has none, stop honestly now — the same stop path as a reset —
      // rather than recording into a void until the next VAD stop.
      if (micOnRef.current && modeDef(next).speech === null) {
        stopMicRef.current()
        notify(
          'Voice needs an Omni server',
          'Low-RAM mode runs only LFM3-1.7B — type instead.',
          'error',
        )
      }
    },
    [addMessage, micOnRef, notify, stopMicRef],
  )

  /**
   * Run-mode switch: blocked while a turn runs (the in-flight turn keeps the
   * models it started with), persisted immediately, and announced in the
   * transcript so the active configuration is never implicit. When the target
   * mode's models differ from what is loaded — missing members, or loaded
   * members it would not use — the switch asks first through the
   * model-manager dialog (npm run models:manager); without the daemon it
   * falls back to the old behavior: switch now, degrade honestly.
   */
  const setMode = useCallback(
    (next: RunMode) => {
      if (next === modeRef.current) return
      if (busyRef.current) {
        notify(
          'Worker is busy',
          'Wait for the current call to finish before switching run mode.',
          'neutral',
        )
        return
      }
      if (pendingSwitch) return // already asking about a switch
      const plan = planModelSwitch(next, healthRef.current)
      if (!plan.toStart.length && !plan.spareLoaded.length) {
        applyMode(next)
        return
      }
      void (async () => {
        if ((await managerStatus()) === null) {
          applyMode(next)
          notify(
            'Models not managed',
            'Run the model manager (npm run models:manager) so mode switches can start models themselves.',
            'neutral',
          )
          return
        }
        setPendingSwitch(plan)
      })()
    },
    [applyMode, busyRef, healthRef, notify, pendingSwitch],
  )

  /**
   * Confirmed switch: start the missing members, optionally stop the spares,
   * poll health until the mode's roster answers (d1-Omni Q8_0 is the slowest
   * to load), then apply the mode. A member that never comes up degrades
   * honestly — the switch still lands, with an error toast naming it.
   */
  const confirmPendingSwitch = useCallback(
    (stopSpares: boolean) => {
      const plan = pendingSwitch
      if (!plan || switchingModels) return
      setSwitchingModels(true)
      void (async () => {
        try {
          try {
            if (plan.toStart.length) await managerStart(plan.toStart.map(managerNameFor))
          } catch {
            applyMode(plan.mode)
            notify(
              'Model manager unreachable',
              'Switched anyway — start the missing models with scripts/start-models.sh.',
              'error',
            )
            return
          }
          if (stopSpares && plan.spareLoaded.length) {
            try {
              await managerStop(plan.spareLoaded.map(managerNameFor))
            } catch {
              // Non-fatal: the spares stay loaded; the mode still runs.
            }
          }
          const deadline = Date.now() + 90_000
          let missing = plan.toStart
          while (missing.length && Date.now() < deadline) {
            await sleep(2000)
            await refreshRuntime()
            missing = plan.toStart.filter((id) => !endpointUp(healthRef.current, id))
          }
          applyMode(plan.mode)
          if (missing.length) {
            const names = missing
              .map((id) => ENDPOINTS.find((endpoint) => endpoint.id === id)?.name ?? id)
              .join(', ')
            notify(
              'Some models did not answer',
              `${names} never came up — those stages degrade honestly until started.`,
              'error',
            )
          }
        } finally {
          setSwitchingModels(false)
          setPendingSwitch(null)
        }
      })()
    },
    [applyMode, healthRef, notify, pendingSwitch, refreshRuntime, switchingModels],
  )

  /** Discard the pending switch without touching any model. */
  const cancelPendingSwitch = useCallback(() => {
    if (switchingModels) return
    setPendingSwitch(null)
  }, [switchingModels])

  return {
    mode,
    modeRef,
    pendingSwitch,
    switchingModels,
    setMode,
    applyMode,
    confirmPendingSwitch,
    cancelPendingSwitch,
  }
}
