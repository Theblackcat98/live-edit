import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ContextUsage,
  ExecutionDiff,
  Message,
  PendingEdit,
  PipelineStage,
  RejectedTraceRecord,
  RuntimeHealth,
  Snapshot,
  StageId,
  StageState,
  Suggestion,
  Toast,
  Trace,
} from '../types'
import { NOTE_PATH, NOTE_TITLE } from '../data/note'
import { buildSuggestions } from '../lib/suggestions'
import { loadWorkspaceState, saveWorkspaceState, type PersistedWorkspace } from '../lib/storage'
import type { RunMode } from '../lib/runmode'
import type { ModelSwitchPlan } from '../lib/modelPlan'
import { runPipelineTurn, type PipelineDeps } from '../lib/pipeline'
import { toStorable } from '../lib/pending'
import { useDemoTurn } from './useDemoTurn'
import { useRuntimeHealth } from './useRuntimeHealth'
import { useSessionClock } from './useSessionClock'
import { useToasts } from './useToasts'
import { useTransientHighlight } from './useTransientHighlight'
import { useWorkspaceHistory } from './useWorkspaceHistory'
import { useWorkspaceModelSwitch } from './useWorkspaceModelSwitch'
import { useWorkspacePending } from './useWorkspacePending'
import { useWorkspaceSpeech } from './useWorkspaceSpeech'
import { useWorkspaceVoice, type SubmitCommand } from './useWorkspaceVoice'
import { useWorkspaceTraces } from './useWorkspaceTraces'
import { useWorkspaceTranscript } from './useWorkspaceTranscript'
import { INITIAL_CONTEXT } from './workspaceSeed'

type ActiveModel = 'omni' | 'd1' | 'worker' | null

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

export { pendingResolutionRecord } from './useWorkspacePending'

export function useWorkspace(): WorkspaceApi {
  // Hydrate persisted workspace once, during first render (before paint).
  const persistedRef = useRef<PersistedWorkspace | null>(null)
  if (!persistedRef.current) persistedRef.current = loadWorkspaceState()
  const persisted = persistedRef.current

  const { messages, setMessages, messagesRef, addMessage, patchMessage, resetMessages } =
    useWorkspaceTranscript({ persisted })

  const { diff, setDiff, clearTransientHighlights, scheduleHighlightClear } = useTransientHighlight()
  const [stage, setStage] = useState<PipelineStage>('idle')
  const [stageStates, setStageStates] = useState<Record<StageId, StageState>>({
    A: 'idle',
    B: 'idle',
    C: 'idle',
  })
  const [busy, setBusy] = useState(false)
  const [flowModel, setFlowModel] = useState<ActiveModel>(null)
  const [contextUsage, setContextUsage] = useState<ContextUsage>(INITIAL_CONTEXT)
  const [sourceMode, setSourceMode] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const { toast, notify, dismissToast } = useToasts()
  const {
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
  } = useWorkspaceTraces({ persisted })
  const { elapsedSeconds, nowTick } = useSessionClock()
  const { runtimeHealth, healthRef, refreshRuntime } = useRuntimeHealth()
  const busyRef = useRef(false)
  const flowModelRef = useRef<ActiveModel>(null)
  const idleTimerRef = useRef<number | null>(null)
  /**
   * Hands-free toggle mirror: the voice hook owns it, the mode-switch hook
   * reads it, so the orchestrator creates it before both.
   */
  const micOnRef = useRef(false)
  /** Latest stopMic, assigned by the voice hook for the mode-switch hook. */
  const stopMicRef = useRef<() => void>(() => {})
  /**
   * Latest submitCommand: the voice and demo hooks resolve a finished capture
   * or a demo step through it, but the turn function is assembled here after
   * every hook.
   */
  const submitRef = useRef<SubmitCommand>(async () => {})
  const chatAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    flowModelRef.current = flowModel
  }, [flowModel])
  const {
    note,
    noteRef,
    history,
    historyIndex,
    historyIndexRef,
    commitNote,
    restoreHistory,
    undo,
    redo,
    restoreSnapshot,
    applySourceEdit,
    newNote,
  } = useWorkspaceHistory({
    persisted,
    busyRef,
    addMessage,
    setDiff,
    setSourceMode,
    notify,
  })

  const {
    mode,
    modeRef,
    pendingSwitch,
    switchingModels,
    setMode,
    confirmPendingSwitch,
    cancelPendingSwitch,
  } = useWorkspaceModelSwitch({
    notify,
    addMessage,
    busyRef,
    healthRef,
    refreshRuntime,
    micOnRef,
    stopMicRef,
  })

  /** Narrow bridge to the trace module: records reach its log by append only. */
  const appendRejectedTrace = useCallback(
    (record: RejectedTraceRecord) => setRejectedTraces((records) => [...records, record]),
    [setRejectedTraces],
  )

  const { pendingEdits, addPendingEdit, applyPendingEdit, dismissPendingEdit } =
    useWorkspacePending({
      persisted,
      busyRef,
      noteRef,
      commitNote,
      setDiff,
      scheduleHighlightClear,
      addMessage,
      notify,
      appendRejectedTrace,
    })

  const { speakerOn, toggleSpeaker, speaking, ttsBusy, stopSpeech, speakReply } =
    useWorkspaceSpeech({ modeRef, healthRef })

  const {
    micOn,
    micActive,
    toggleMic,
    asrBusy,
    getMicLevel,
    stopMic,
    recorderRef,
    asrSourceRef,
    lastVoiceSecondsRef,
  } = useWorkspaceVoice({
    modeRef,
    healthRef,
    busyRef,
    notify,
    stopSpeech,
    micOnRef,
    stopMicRef,
    submitRef,
  })

  // The turn pipeline (lib/pipeline.ts) owns the stage sequence; these are
  // the session capabilities it borrows from the hooks. Built fresh each
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

  // Late-bind the composed turn function: voice capture and the demo loop
  // resolve through it, but they are declared before this pipeline exists.
  submitRef.current = submitCommand

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
    resetMessages()
    resetTraces()
    setStage('idle')
    setStageStates({ A: 'idle', B: 'idle', C: 'idle' })
    setFlowModel(null)
    setCommandInput('')
    notify(
      'New chat',
      'The conversation and decision traces were cleared. The note and its snapshots stay.',
      'success',
    )
  }, [notify, resetMessages, resetTraces, stopMic, stopSpeech])

  const suggestions = useMemo(() => buildSuggestions(note), [note])

  const { demoRunning, runDemo } = useDemoTurn({ busyRef, notify, submitRef })

  useEffect(() => {
    return () => {
      // Unmount is a stop path for the turn: the speech hook aborts its own
      // recorder and TTS on unmount too, so only the pipeline's controller
      // and timers are cleared here.
      chatAbortRef.current?.abort()
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    }
  }, [])

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
