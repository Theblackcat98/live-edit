import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ContextUsage,
  ExecutionDiff,
  Message,
  PendingEdit,
  PipelineStage,
  RejectedTraceRecord,
  RuntimeHealth,
  RuntimeSource,
  Snapshot,
  StageId,
  StageState,
  Suggestion,
  Toast,
  Trace,
} from '../types'
import { DEMO_SEQUENCE, INITIAL_NOTE, NOTE_PATH, NOTE_TITLE } from '../data/note'
import { speak, stopSpeaking, cleanSpeechText, speechSynthesisAvailable, VoiceRecorder } from '../lib/speech'
import { buildSuggestions } from '../lib/suggestions'
import { loadWorkspaceState, saveWorkspaceState, type PersistedWorkspace } from '../lib/storage'
import { ENDPOINTS, endpointUp, probeRuntime, synthesizeSpeech, transcribeAudio } from '../lib/bridge'
import {
  loadRunMode,
  saveRunMode,
  speechPortFor,
  type RunMode,
} from '../lib/runmode'
import { modeDef } from '../lib/modes'
import { managerStart, managerStatus, managerStop } from '../lib/modelManager'
import { managerNameFor, planModelSwitch, type ModelSwitchPlan } from '../lib/modelPlan'
import { estimateTokens, makeId, sleep } from '../lib/utils'
import { runPipelineTurn, type PipelineDeps, type RunResultSnapshot } from '../lib/pipeline'
import {
  adjudicate,
  enqueue,
  fromStorable,
  toStorable,
  type PendingAdjudication,
} from '../lib/pending'
import { noteHash } from '../lib/context'
import { executeTool } from '../lib/tools'
import { useToasts } from './useToasts'

const initialNoteTokens = estimateTokens(INITIAL_NOTE)
const INITIAL_CONTEXT: ContextUsage = {
  omni: initialNoteTokens + 620,
  d1: initialNoteTokens * 2 + 1450,
  worker: Math.round(initialNoteTokens * 0.35) + 900,
}

type ActiveModel = 'omni' | 'd1' | 'worker' | null

function initialMessages(): Message[] {
  const now = Date.now()
  return [
    {
      id: makeId('msg'),
      role: 'system',
      kind: 'notice',
      text: 'Session ready · local runtime · audio input ready',
      at: now - 800,
    },
    {
      id: makeId('msg'),
      role: 'assistant',
      author: 'harness',
      kind: 'greeting',
      text: "I'm reading your note. Tell me what to change.",
      at: now - 400,
    },
  ]
}

function initialSnapshot(): Snapshot {
  return {
    id: makeId('snap'),
    at: Date.now(),
    label: 'Session start',
    note: INITIAL_NOTE,
    tool: 'baseline',
    automatic: false,
  }
}

export interface WorkspaceApi {
  note: string
  title: string
  path: string
  messages: Message[]
  history: Snapshot[]
  historyIndex: number
  canUndo: boolean
  canRedo: boolean
  trace: Trace | null
  runs: Trace[]
  selectedTrace: Trace | null
  rejectedTraces: RejectedTraceRecord[]
  /** Pending edits awaiting (or resolved by) user adjudication, oldest first (design.md §9). */
  pendingEdits: PendingEdit[]
  applyPendingEdit: (id: string) => void
  dismissPendingEdit: (id: string) => void
  traceOpen: boolean
  openTrace: (id?: string) => void
  closeTrace: () => void
  stage: PipelineStage
  stageStates: Record<StageId, StageState>
  busy: boolean
  diff: ExecutionDiff | null
  contextUsage: ContextUsage
  sourceMode: boolean
  setSourceMode: (value: boolean) => void
  speakerOn: boolean
  toggleSpeaker: () => void
  /** Hands-free listening toggle: stays on across utterances until toggled off. */
  micOn: boolean
  /** True only while a recorder is live (micOn stays on between utterances). */
  micActive: boolean
  toggleMic: () => void
  asrBusy: boolean
  getMicLevel: () => number
  speaking: boolean
  ttsBusy: boolean
  stopSpeech: () => void
  resetChat: () => void
  newNote: () => void
  suggestions: Suggestion[]
  activeModel: ActiveModel
  elapsedSeconds: number
  nowTick: number
  commandInput: string
  setCommandInput: (value: string) => void
  submitCommand: (command: string, source?: 'text' | 'voice' | 'demo') => Promise<void>
  undo: () => void
  redo: () => void
  restoreSnapshot: (id: string) => void
  applySourceEdit: (note: string) => boolean
  toast: Toast | null
  dismissToast: () => void
  demoRunning: boolean
  runDemo: () => Promise<void>
  runtimeHealth: RuntimeHealth | null
  refreshRuntime: () => Promise<void>
  /** Active run mode: which local models serve chat and edits. */
  mode: RunMode
  /** Switch run mode (blocked while a turn runs); persists across reloads. */
  setMode: (mode: RunMode) => void
  /** A mode switch waiting on the model-manager dialog (start/stop members). */
  pendingSwitch: ModelSwitchPlan | null
  /** True while a confirmed switch starts/stops members and polls health. */
  switchingModels: boolean
  /** Apply the pending switch: start missing members, optionally stop spares. */
  confirmPendingSwitch: (stopSpares: boolean) => void
  /** Discard the pending switch without touching any model. */
  cancelPendingSwitch: () => void
}

/**
 * The rejected-traces record for a resolved pending edit (§9.5). Grounding
 * is honestly marked `pending-adjudication`: the user, not a grounding
 * pass, made this call.
 */
export function pendingResolutionRecord(edit: PendingEdit, reason: string): RejectedTraceRecord {
  return {
    at: Date.now(),
    command: edit.directive.instruction,
    route: { tool: edit.call.name, provenance: 'pending edit adjudication' },
    grounding: { source: 'pending-adjudication' },
    workerXml: edit.call.xml,
    critic: { verdict: 'rejected', reason, pCorrect: edit.d1.noul },
    directive: edit.directive,
    // §9.5: the record carries the proposal — directive, call, AND the d1
    // verdict that routed it to adjudication (battery case 32: the verdict
    // was dropped here even though the type has the field).
    d1: edit.d1,
  }
}

export function useWorkspace(): WorkspaceApi {
  const initialSnapshotRef = useRef<Snapshot | null>(null)
  if (!initialSnapshotRef.current) initialSnapshotRef.current = initialSnapshot()

  // Hydrate persisted workspace once, during first render (before paint).
  const persistedRef = useRef<PersistedWorkspace | null>(null)
  if (!persistedRef.current) persistedRef.current = loadWorkspaceState()
  const persisted = persistedRef.current

  const [note, setNote] = useState(persisted?.note ?? INITIAL_NOTE)
  const [messages, setMessages] = useState<Message[]>(() =>
    (persisted?.messages ?? initialMessages()).map((message) =>
      // A stream cut off by a reload must not leave a permanent caret.
      message.streaming ? { ...message, streaming: false } : message,
    ),
  )
  const [history, setHistory] = useState<Snapshot[]>(() =>
    persisted?.snapshots.length ? persisted.snapshots : [initialSnapshotRef.current as Snapshot],
  )
  const [historyIndex, setHistoryIndex] = useState(() =>
    persisted?.snapshots.length ? persisted.snapshots.length - 1 : 0,
  )
  const [trace, setTrace] = useState<Trace | null>(null)
  const [runs, setRuns] = useState<Trace[]>(persisted?.runs ?? [])
  const [stage, setStage] = useState<PipelineStage>('idle')
  const [stageStates, setStageStates] = useState<Record<StageId, StageState>>({
    A: 'idle',
    B: 'idle',
    C: 'idle',
  })
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<ExecutionDiff | null>(null)
  const [flowModel, setFlowModel] = useState<ActiveModel>(null)
  const [speaking, setSpeaking] = useState(false)
  const [speakerOn, setSpeakerOn] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [micActive, setMicActive] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsage>(INITIAL_CONTEXT)
  const [sourceMode, setSourceMode] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const { toast, notify, dismissToast } = useToasts()
  const [traceOpen, setTraceOpen] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [demoRunning, setDemoRunning] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [nowTick, setNowTick] = useState(Date.now())
  const [sessionStart] = useState(() => Date.now())
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<ModelSwitchPlan | null>(null)
  const [switchingModels, setSwitchingModels] = useState(false)
  const [mode, setModeState] = useState<RunMode>(() => loadRunMode())
  const [asrBusy, setAsrBusy] = useState(false)
  const [ttsBusy, setTtsBusy] = useState(false)
  const [rejectedTraces, setRejectedTraces] = useState<RejectedTraceRecord[]>(
    persisted?.rejectedTraces ?? [],
  )
  // Reloaded pendings pass through pending.ts's defensive per-entry
  // validation — a malformed entry drops out instead of bricking the queue.
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>(() =>
    fromStorable(persisted?.pendingEdits ?? []),
  )
  const pendingEditsRef = useRef<PendingEdit[]>(pendingEdits)

  const noteRef = useRef(note)
  const historyRef = useRef(history)
  const historyIndexRef = useRef(historyIndex)
  const runsRef = useRef<Trace[]>(runs)
  const traceRef = useRef<Trace | null>(null)
  const busyRef = useRef(false)
  const speakerOnRef = useRef(speakerOn)
  const flowModelRef = useRef<ActiveModel>(null)
  const idleTimerRef = useRef<number | null>(null)
  const highlightTimerRef = useRef<number | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const speechTokenRef = useRef(0)
  const demoRunningRef = useRef(false)
  const demoStopRef = useRef(false)
  const healthRef = useRef<RuntimeHealth | null>(null)
  const modeRef = useRef<RunMode>(mode)
  /** Hands-free toggle mirror: capture callbacks outlive the render they began in. */
  const micOnRef = useRef(false)
  const asrBusyRef = useRef(false)
  /** Latest finishVoiceCapture, for VoiceRecorder.autoStop callbacks created earlier. */
  const finishVoiceCaptureRef = useRef<() => Promise<void>>(async () => {})
  /** Latest stopMic, callable from the mode switch declared above it. */
  const stopMicRef = useRef<() => void>(() => {})
  /** Endpoint the active mic capture started against (mode is read at start, not at stop). */
  const micEndpointRef = useRef<'omni' | 'd1omni' | 'audio' | null>(null)
  const asrSourceRef = useRef<RuntimeSource>('fallback')
  const lastVoiceSecondsRef = useRef<number | undefined>(undefined)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsAbortRef = useRef<AbortController | null>(null)
  const ttsUrlRef = useRef<string | null>(null)
  const chatAbortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<Message[]>(messages)

  useEffect(() => {
    noteRef.current = note
  }, [note])
  useEffect(() => {
    historyRef.current = history
  }, [history])
  useEffect(() => {
    pendingEditsRef.current = pendingEdits
  }, [pendingEdits])
  // Debounced workspace persistence — best-effort, never breaks the UI.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveWorkspaceState({
        note,
        snapshots: history,
        messages,
        runs,
        rejectedTraces,
        // D3: only unresolved pendings persist, capped by the store.
        pendingEdits: toStorable(pendingEdits),
      })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [note, history, messages, runs, rejectedTraces, pendingEdits])
  useEffect(() => {
    historyIndexRef.current = historyIndex
  }, [historyIndex])
  useEffect(() => {
    traceRef.current = trace
  }, [trace])
  useEffect(() => {
    speakerOnRef.current = speakerOn
  }, [speakerOn])
  useEffect(() => {
    flowModelRef.current = flowModel
  }, [flowModel])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - sessionStart) / 1000))
      setNowTick(Date.now())
    }, 1000)
    setElapsedSeconds(Math.floor((Date.now() - sessionStart) / 1000))
    return () => window.clearInterval(timer)
  }, [sessionStart])

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

  const addMessage = useCallback(
    (message: Omit<Message, 'id' | 'at'> & { at?: number; id?: string }) => {
      const id = message.id ?? makeId('msg')
      const full: Message = { ...message, id, at: message.at ?? Date.now() }
      setMessages((previous) => [...previous, full])
      return id
    },
    [],
  )

  const patchMessage = useCallback((id: string, patch: Partial<Message>) => {
    setMessages((previous) =>
      previous.map((message) => (message.id === id ? { ...message, ...patch } : message)),
    )
  }, [])

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
    [addMessage, notify],
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
    [applyMode, notify, pendingSwitch],
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
            const health = await probeRuntime()
            healthRef.current = health
            setRuntimeHealth(health)
            missing = plan.toStart.filter((id) => !endpointUp(health, id))
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
    [pendingSwitch, switchingModels, applyMode, notify],
  )

  /** Discard the pending switch without touching any model. */
  const cancelPendingSwitch = useCallback(() => {
    if (switchingModels) return
    setPendingSwitch(null)
  }, [switchingModels])

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

  const commitNote = useCallback(
    (nextNote: string, label: string, tool: string): Snapshot => {
      const base = historyRef.current
      const index = historyIndexRef.current
      const snapshot: Snapshot = {
        id: makeId('snap'),
        at: Date.now(),
        label,
        note: nextNote,
        tool,
        automatic: true,
      }
      const nextHistory = [...base.slice(0, index + 1), snapshot].slice(-40)
      const nextIndex = nextHistory.length - 1
      historyRef.current = nextHistory
      historyIndexRef.current = nextIndex
      setHistory(nextHistory)
      setHistoryIndex(nextIndex)
      noteRef.current = nextNote
      setNote(nextNote)
      return snapshot
    },
    [],
  )

  const restoreHistory = useCallback((targetIndex: number): RunResultSnapshot => {
    const currentHistory = historyRef.current
    const target = currentHistory[targetIndex]
    if (!target) {
      return { ok: false, message: 'No snapshot exists at that position.', note: noteRef.current }
    }
    historyIndexRef.current = targetIndex
    setHistoryIndex(targetIndex)
    noteRef.current = target.note
    setNote(target.note)
    setDiff(null)
    setSourceMode(false)
    return {
      ok: true,
      message: `Restored “${target.label}”.`,
      snapshot: target,
      note: target.note,
    }
  }, [])

  // --- Pending-edit adjudication (design.md §9) ------------------------------
  // Adjudication is not a turn: it respects the same busy gate as undo and
  // never runs the pipeline. The store (lib/pending) decides; this hook
  // executes an approved call and keeps the records.
  const addPendingEdit = useCallback((pending: PendingEdit) => {
    setPendingEdits((previous) => enqueue(previous, pending))
  }, [])

  const resolvePending = useCallback(
    (id: string, decision: 'apply' | 'discard') => {
      const edit = pendingEditsRef.current.find((entry) => entry.id === id)
      if (!edit || edit.status !== 'pending') return
      const outcome: PendingAdjudication = adjudicate(edit, decision, noteRef.current, { noteHash })
      setPendingEdits((previous) =>
        previous.map((entry) => (entry.id === id ? outcome.edit : entry)),
      )
      if (outcome.status === 'applied' && outcome.call) {
        const execution = executeTool(
          noteRef.current,
          outcome.call,
          edit.overrideBlastRadius ? { overrideBlastRadius: true } : {},
        )
        if (!execution.ok) {
          // The store gate-validated the call; the engine refusing anyway is
          // a drift between the two — surface it honestly, write nothing.
          setPendingEdits((previous) =>
            previous.map((entry) =>
              entry.id === id ? { ...entry, status: 'stale' as const } : entry,
            ),
          )
          setRejectedTraces((records) => [
            ...records,
            pendingResolutionRecord(outcome.edit, `Engine refused at execution: ${execution.message}`),
          ])
          addMessage({
            role: 'assistant',
            author: 'harness',
            kind: 'error',
            text: `That pending edit passed the gates but the engine refused it: ${execution.message} Nothing was written.`,
          })
          return
        }
        commitNote(execution.note, `Pending edit approved · ${outcome.call.name}`, outcome.call.name)
        setDiff(execution.diff ?? null)
        scheduleHighlightClear()
        addMessage({
          role: 'assistant',
          author: 'harness',
          kind: 'result',
          text: `Applied the pending ${outcome.call.name} edit you approved.`,
        })
        notify('Pending edit applied', execution.message, 'success')
        return
      }
      // stale or discarded: nothing written; the proposal joins the
      // rejected-traces log (§9.5).
      setRejectedTraces((records) => [
        ...records,
        pendingResolutionRecord(
          outcome.edit,
          outcome.status === 'discarded'
            ? 'Discarded by the user at adjudication (design.md §9).'
            : outcome.reason,
        ),
      ])
      addMessage({
        role: 'assistant',
        author: 'harness',
        kind: 'notice',
        text:
          outcome.status === 'stale'
            ? `That pending edit went stale and was not applied. ${outcome.reason}`
            : 'Discarded the pending edit. The note was not touched.',
      })
      if (outcome.status === 'stale') notify('Pending edit went stale', outcome.reason, 'error')
    },
    [addMessage, commitNote, notify, scheduleHighlightClear],
  )

  const applyPendingEdit = useCallback(
    (id: string) => {
      if (busyRef.current) {
        notify('Worker is busy', 'Wait for the current turn to finish before applying a pending edit.', 'neutral')
        return
      }
      resolvePending(id, 'apply')
    },
    [notify, resolvePending],
  )

  const dismissPendingEdit = useCallback(
    (id: string) => {
      resolvePending(id, 'discard')
    },
    [resolvePending],
  )

  const undo = useCallback(() => {
    if (busyRef.current) {
      notify('Worker is busy', 'Wait for the current verified call to finish.', 'neutral')
      return
    }
    const result = restoreHistory(historyIndexRef.current - 1)
    if (!result.ok) {
      notify('Nothing to undo', 'The note is already at its first snapshot.')
      return
    }
    notify('Snapshot restored', result.message, 'success')
  }, [notify, restoreHistory])

  const redo = useCallback(() => {
    if (busyRef.current) {
      notify('Worker is busy', 'Wait for the current verified call to finish.', 'neutral')
      return
    }
    const result = restoreHistory(historyIndexRef.current + 1)
    if (!result.ok) {
      notify('Nothing to redo', 'The note is already at its latest snapshot.')
      return
    }
    notify('Snapshot reapplied', result.message, 'success')
  }, [notify, restoreHistory])

  const restoreSnapshot = useCallback(
    (id: string) => {
      if (busyRef.current) {
        notify('Worker is busy', 'Wait for the current verified call to finish.', 'neutral')
        return
      }
      const index = historyRef.current.findIndex((snapshot) => snapshot.id === id)
      if (index < 0) return
      const result = restoreHistory(index)
      if (result.ok) notify('Snapshot restored', result.message, 'success')
    },
    [notify, restoreHistory],
  )

  const applySourceEdit = useCallback(
    (nextNote: string): boolean => {
      if (busyRef.current) {
        notify('Worker is busy', 'Wait for the verified call to finish before editing.', 'neutral')
        return false
      }
      if (nextNote === noteRef.current) return false
      commitNote(nextNote, 'Manual source edit', 'manual')
        setDiff(null)
      addMessage({
        role: 'system',
        kind: 'notice',
        text: 'Manual source edit committed · new snapshot',
      })
      notify('Source edit committed', 'A local snapshot was added to the history rail.', 'success')
      return true
    },
    [addMessage, commitNote, notify],
  )

  const stopSpeech = useCallback(() => {
    speechTokenRef.current += 1
    ttsAbortRef.current?.abort()
    ttsAbortRef.current = null
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause()
      ttsAudioRef.current = null
    }
    if (ttsUrlRef.current) {
      URL.revokeObjectURL(ttsUrlRef.current)
      ttsUrlRef.current = null
    }
    stopSpeaking()
    setSpeaking(false)
    setTtsBusy(false)
  }, [])

  const speakReply = useCallback(
    (text: string) => {
      if (!speakerOnRef.current) return
      speechTokenRef.current += 1
      const token = speechTokenRef.current
      const clean = cleanSpeechText(text)
      if (!clean) return

      // Browser-voice dispatch: the speaking state is set at DISPATCH, not
      // on the utterance's onstart — headless and some embedded browsers
      // never fire onstart, which left a playing reply with a permanently
      // disabled Stop button (battery case 17a). onend/onerror still clear
      // it; stopSpeech cancels the utterance outright.
      const speakWithBrowserVoice = (value: string) => {
        if (!speechSynthesisAvailable()) return
        setSpeaking(true)
        speak(value, {
          onStart: () => {
            if (speechTokenRef.current === token) setSpeaking(true)
          },
          onEnd: () => {
            if (speechTokenRef.current === token) setSpeaking(false)
          },
        })
      }

      // Live path: the mode's Omni-architecture server speaks its own reply
      // over /tts (24 kHz WAV). Low-RAM has no such server
      // (modeDef(...).speech → null) and always uses the browser voice.
      const ttsEndpoint = modeDef(modeRef.current).speech
      if (ttsEndpoint && endpointUp(healthRef.current, ttsEndpoint)) {
        setTtsBusy(true)
        const controller = new AbortController()
        ttsAbortRef.current = controller
        void (async () => {
          try {
            const blob = await synthesizeSpeech(clean, {
              signal: controller.signal,
              endpoint: ttsEndpoint,
            })
            if (speechTokenRef.current !== token) return
            const url = URL.createObjectURL(blob)
            ttsUrlRef.current = url
            const audio = new Audio(url)
            ttsAudioRef.current = audio
            audio.onended = () => {
              if (speechTokenRef.current !== token) return
              setSpeaking(false)
              URL.revokeObjectURL(url)
              if (ttsUrlRef.current === url) ttsUrlRef.current = null
              ttsAudioRef.current = null
            }
            audio.onerror = () => {
              if (speechTokenRef.current !== token) return
              setSpeaking(false)
              // Model audio failed mid-playback — finish with the browser voice.
              speakWithBrowserVoice(clean)
            }
            setSpeaking(true)
            await audio.play()
          } catch (error) {
            if (controller.signal.aborted || speechTokenRef.current !== token) return
            // TTS request failed — fall back to the browser voice.
            speakWithBrowserVoice(clean)
          } finally {
            if (speechTokenRef.current === token) setTtsBusy(false)
          }
        })()
        return
      }

      // Fallback: browser speechSynthesis.
      speakWithBrowserVoice(clean)
    },
    [],
  )

  const toggleSpeaker = useCallback(() => {
    setSpeakerOn((previous) => {
      const next = !previous
      speakerOnRef.current = next
      if (!next) {
        speechTokenRef.current += 1
        stopSpeaking()
        setSpeaking(false)
      }
      return next
    })
  }, [])

  /** State + mirror in one step: capture callbacks read the ref, not a render. */
  const setMicToggle = useCallback((on: boolean) => {
    micOnRef.current = on
    setMicOn(on)
  }, [])

  const notifyVoiceNeedsOmni = useCallback(() => {
    notify(
      'Voice needs an Omni server',
      'Low-RAM mode runs only LFM3-1.7B — type instead.',
      'error',
    )
  }, [notify])

  const notifySpeechOffline = useCallback(
    (endpoint: 'omni' | 'd1omni' | 'audio') => {
      const port = speechPortFor(endpoint)
      notify(
        endpoint === 'omni' ? 'Omni ASR offline' : endpoint === 'audio' ? 'Audio ASR offline' : 'd1-Omni ASR offline',
        endpoint === 'omni'
          ? `LFM3-Omni-2B is not answering on :${port} — start it with ./lfm3.sh omni, or type the command.`
          : endpoint === 'audio'
            ? `LFM3-Audio-2B is not answering on :${port} — start it with scripts/start-models.sh, or type the command.`
            : `d1-Omni-2B is not answering on :${port} — start it, or type the command.`,
        'error',
      )
    },
    [notify],
  )

  const stopMic = useCallback(() => {
    // The ONE path allowed to abandon a capture without submitting it
    // (reset, unmount, a mode that has no speech server): the toggle goes
    // off, the recorder is aborted, and no re-arm follows.
    setMicToggle(false)
    recorderRef.current?.abort()
    recorderRef.current = null
    micEndpointRef.current = null
    setMicActive(false)
  }, [setMicToggle])

  useEffect(() => {
    stopMicRef.current = stopMic
  }, [stopMic])

  // The turn pipeline (lib/pipeline.ts) owns the stage sequence; these are
  // the session capabilities it borrows from the hook. Built fresh each
  // render so the pipeline always sees the current callbacks — the same
  // freshness the inlined implementation had via its closures.
  const pipelineDeps: PipelineDeps = {
    busyRef,
    noteRef,
    historyIndexRef,
    runsRef,
    messagesRef,
    healthRef,
    modeRef,
    asrSourceRef,
    lastVoiceSecondsRef,
    chatAbortRef,
    idleTimerRef,
    traceRef,
    recorderRef,
    setBusy,
    setCommandInput,
    setSourceMode,
    setDiff,
    setStage,
    setStageStates,
    setFlowModel,
    setTrace,
    setRuns,
    setMessages,
    setContextUsage,
    setRejectedTraces,
    addPendingEdit,
    addMessage,
    patchMessage,
    restoreHistory,
    commitNote,
    notify,
    stopSpeech,
    stopMic,
    clearTransientHighlights,
    speakReply,
    scheduleHighlightClear,
  }

  async function submitCommand(
    rawCommand: string,
    source: 'text' | 'voice' | 'demo' = 'text',
  ): Promise<void> {
    await runPipelineTurn(pipelineDeps, rawCommand, source)
  }

  /**
   * Open one capture. Returns false when the microphone could not be opened
   * (a toast has been shown); the caller decides whether that ends the
   * hands-free toggle.
   */
  const beginCapture = useCallback(
    async (endpoint: 'omni' | 'd1omni' | 'audio'): Promise<boolean> => {
      const recorder = new VoiceRecorder({
        // The VAD ending an utterance is NOT the user ending hands-free:
        // finishVoiceCapture transcribes + submits, then re-arms if the
        // toggle is still on.
        onAutoStop: () => {
          void finishVoiceCaptureRef.current()
        },
        // Barge-in: voice onset cuts a spoken reply mid-sentence. Fires at
        // most once per capture (the recorder latches on voice onset).
        onVoiceStart: () => stopSpeech(),
      })
      try {
        await recorder.start()
      } catch {
        notify(
          'Microphone permission denied',
          'Allow microphone access in the browser, or type the command.',
          'error',
        )
        return false
      }
      recorderRef.current = recorder
      micEndpointRef.current = endpoint
      setMicActive(true)
      return true
    },
    [notify, stopSpeech],
  )

  /**
   * Re-arm listening after an utterance when hands-free is still on. The
   * guards are re-run against the CURRENT mode/health: a switch to low-RAM
   * (no speech server) or an endpoint that went away ends hands-free with
   * the honest toast instead of leaving the UI claiming to listen.
   */
  const restartHandsFree = useCallback(async () => {
    if (!micOnRef.current) return
    const endpoint = modeDef(modeRef.current).speech
    if (!endpoint) {
      setMicToggle(false)
      notifyVoiceNeedsOmni()
      return
    }
    if (!endpointUp(healthRef.current, endpoint)) {
      setMicToggle(false)
      notifySpeechOffline(endpoint)
      return
    }
    const started = await beginCapture(endpoint)
    if (!started) {
      // A failed re-arm ends hands-free: the toggle must never claim to be
      // listening with no recorder behind it.
      setMicToggle(false)
      return
    }
    if (!micOnRef.current) {
      // Tapped off while the microphone was opening.
      recorderRef.current?.abort()
      recorderRef.current = null
      micEndpointRef.current = null
      setMicActive(false)
    }
  }, [beginCapture, notifySpeechOffline, notifyVoiceNeedsOmni, setMicToggle])

  const finishVoiceCapture = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = null
    setMicActive(false)
    // The endpoint is the one the capture started against; a mode switch
    // mid-capture must not retarget a finished recording.
    const endpoint = micEndpointRef.current ?? modeDef(modeRef.current).speech
    micEndpointRef.current = null
    asrBusyRef.current = true
    setAsrBusy(true)
    const seconds = recorder.seconds
    try {
      const blob = await recorder.stop()
      if (!blob) {
        notify(
          'No speech captured',
          'The microphone did not pick up anything. Try again or type the command.',
          'error',
        )
      } else if (!endpoint) {
        // The mode this capture belonged to no longer offers a speech server
        // (a switch to low-RAM mid-capture): stop hands-free here; the re-arm
        // below then finds the toggle off and stays quiet.
        setMicToggle(false)
        notifyVoiceNeedsOmni()
      } else {
        // Live ASR over the mode's Omni-architecture endpoint (:8083 omni,
        // :8085 in 1.7B + d1 — same architecture).
        const transcript = await transcribeAudio(blob, endpoint)
        asrSourceRef.current = 'live'
        lastVoiceSecondsRef.current = Number(seconds.toFixed(1))
        // Awaiting the turn is the hands-free sequencing guarantee:
        // runPipelineTurn resolves only after its finally cleared busyRef, so
        // the re-arm below can never listen underneath a running turn.
        await submitCommand(transcript.text, 'voice')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ASR request failed.'
      const label = endpoint === 'd1omni' ? 'd1-Omni' : endpoint === 'audio' ? 'Audio' : 'Omni'
      notify(`${label} ASR unavailable`, `${message} Type the command instead.`, 'error')
    } finally {
      asrBusyRef.current = false
      setAsrBusy(false)
      // Utterance over — the VAD stopped this capture, not the user. If the
      // toggle is still on, listen for the next one.
      await restartHandsFree()
    }
  }, [notify, notifySpeechOffline, notifyVoiceNeedsOmni, restartHandsFree, setMicToggle])

  useEffect(() => {
    finishVoiceCaptureRef.current = finishVoiceCapture
  }, [finishVoiceCapture])

  const toggleMic = useCallback(() => {
    // Barge-in: speaking while you talk would fight the microphone.
    stopSpeech()
    if (micOnRef.current) {
      // OFF: never discard spoken words. A capture in progress is finished
      // (transcribed + submitted) and not restarted; an in-flight ASR/submit
      // is allowed to complete and submit. Clearing the toggle is what ends
      // the loop — finishVoiceCapture's re-arm reads it.
      setMicToggle(false)
      if (recorderRef.current) void finishVoiceCapture()
      return
    }
    if (busyRef.current) {
      notify('Worker is busy', 'Wait for the current call to finish before speaking.', 'neutral')
      return
    }
    const endpoint = modeDef(modeRef.current).speech
    if (!endpoint) {
      // Low-RAM: no Omni-architecture server exists, so ASR is honestly off.
      notifyVoiceNeedsOmni()
      return
    }
    if (!endpointUp(healthRef.current, endpoint)) {
      notifySpeechOffline(endpoint)
      return
    }
    // ON: the toggle is set before the permission prompt so a second tap
    // cancels instead of opening a second stream; a failed start rolls it
    // back below.
    setMicToggle(true)
    if (asrBusyRef.current) {
      // The previous utterance is still transcribing; arming now is honest —
      // finishVoiceCapture's re-arm picks the toggle up when it resolves.
      return
    }
    void (async () => {
      const started = await beginCapture(endpoint)
      if (!started) {
        setMicToggle(false)
        return
      }
      if (!micOnRef.current) {
        // Tapped off while the permission prompt was open: no capture runs
        // for a toggle that is already off.
        recorderRef.current?.abort()
        recorderRef.current = null
        micEndpointRef.current = null
        setMicActive(false)
      }
    })()
  }, [
    beginCapture,
    finishVoiceCapture,
    notify,
    notifySpeechOffline,
    notifyVoiceNeedsOmni,
    setMicToggle,
    stopSpeech,
  ])

  const getMicLevel = useCallback(() => recorderRef.current?.getLevel() ?? 0, [])

  const newNote = useCallback(() => {
    if (busyRef.current) {
      notify(
        'Worker is busy',
        'Wait for the current verified call to finish before starting a new note.',
        'neutral',
      )
      return
    }
    commitNote('# Untitled\n\n', 'New note', 'manual')
    setDiff(null)
    setSourceMode(false)
    notify(
      'New note',
      'A blank note replaced the document. Undo restores the previous note.',
      'success',
    )
  }, [commitNote, notify, setSourceMode])

  const resetChat = useCallback(() => {
    if (busyRef.current) {
      notify(
        'Worker is busy',
        'Wait for the current verified call to finish before starting a new chat.',
        'neutral',
      )
      return
    }
    stopSpeech()
    stopMic()
    chatAbortRef.current?.abort()
    chatAbortRef.current = null
    setMessages(initialMessages())
    runsRef.current = []
    setRuns([])
    setSelectedTraceId(null)
    setTrace(null)
    setStage('idle')
    setStageStates({ A: 'idle', B: 'idle', C: 'idle' })
    setFlowModel(null)
    setCommandInput('')
    notify(
      'New chat',
      'The conversation and decision traces were cleared. The note and its snapshots stay.',
      'success',
    )
  }, [notify, stopMic, stopSpeech])

  const openTrace = useCallback(
    (id?: string) => {
      setSelectedTraceId(id ?? traceRef.current?.id ?? null)
      setTraceOpen(true)
    },
    [],
  )

  const closeTrace = useCallback(() => setTraceOpen(false), [])

  const selectedTrace = useMemo(() => {
    if (selectedTraceId) {
      return runs.find((run) => run.id === selectedTraceId) ?? (trace?.id === selectedTraceId ? trace : null)
    }
    return trace
  }, [runs, selectedTraceId, trace])

  const suggestions = useMemo(() => buildSuggestions(note), [note])

  const runDemo = useCallback(async () => {
    if (demoRunningRef.current) {
      demoStopRef.current = true
      setDemoRunning(false)
      notify('Demo stopping', 'The current verified call will finish first.')
      return
    }
    if (busyRef.current) {
      notify('Worker is busy', 'Wait for the current call to finish before starting the demo.', 'neutral')
      return
    }
    demoStopRef.current = false
    demoRunningRef.current = true
    setDemoRunning(true)
    for (const step of DEMO_SEQUENCE) {
      if (demoStopRef.current) break
      await submitCommand(step.command, step.source)
      await sleep(650)
    }
    demoStopRef.current = false
    demoRunningRef.current = false
    setDemoRunning(false)
  }, [notify, submitCommand])

  useEffect(() => {
    return () => {
      // Unmount is a stop path: never let an in-flight ASR/turn re-arm the
      // microphone after the session is gone.
      micOnRef.current = false
      recorderRef.current?.abort()
      recorderRef.current = null
      ttsAbortRef.current?.abort()
      chatAbortRef.current?.abort()
      stopSpeaking()
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current)
    }
  }, [])

  const activeModel: ActiveModel = speaking ? 'omni' : flowModel

  return {
    note,
    title: NOTE_TITLE,
    path: NOTE_PATH,
    messages,
    history,
    historyIndex,
    canUndo: historyIndex > 0,
    canRedo: historyIndex < history.length - 1,
    trace,
    runs,
    selectedTrace,
    rejectedTraces,
    pendingEdits,
    applyPendingEdit,
    dismissPendingEdit,
    traceOpen,
    openTrace,
    closeTrace,
    stage,
    stageStates,
    busy,
    diff,
    contextUsage,
    sourceMode,
    setSourceMode,
    speakerOn,
    toggleSpeaker,
    micOn,
    micActive,
    toggleMic,
    asrBusy,
    getMicLevel,
    speaking,
    ttsBusy,
    stopSpeech,
    resetChat,
    newNote,
    suggestions,
    activeModel,
    elapsedSeconds,
    nowTick,
    commandInput,
    setCommandInput,
    submitCommand,
    undo,
    redo,
    restoreSnapshot,
    applySourceEdit,
    toast,
    dismissToast,
    demoRunning,
    runDemo,
    runtimeHealth,
    refreshRuntime,
    mode,
    setMode,
    pendingSwitch,
    switchingModels,
    confirmPendingSwitch,
    cancelPendingSwitch,
  }
}




