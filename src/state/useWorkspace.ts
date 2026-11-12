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
import { endpointUp, synthesizeSpeech, transcribeAudio } from '../lib/bridge'
import { speechPortFor, type RunMode } from '../lib/runmode'
import { modeDef } from '../lib/modes'
import type { ModelSwitchPlan } from '../lib/modelPlan'
import { estimateTokens, makeId, sleep } from '../lib/utils'
import { runPipelineTurn, type PipelineDeps } from '../lib/pipeline'
import {
  toStorable,
} from '../lib/pending'
import { useRuntimeHealth } from './useRuntimeHealth'
import { useSessionClock } from './useSessionClock'
import { useToasts } from './useToasts'
import { useWorkspaceHistory } from './useWorkspaceHistory'
import { useWorkspaceModelSwitch } from './useWorkspaceModelSwitch'
import { useWorkspacePending } from './useWorkspacePending'
import { useWorkspaceTraces } from './useWorkspaceTraces'

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

  const [messages, setMessages] = useState<Message[]>(() =>
    (persisted?.messages ?? initialMessages()).map((message) =>
      // A stream cut off by a reload must not leave a permanent caret.
      message.streaming ? { ...message, streaming: false } : message,
    ),
  )
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
  const [demoRunning, setDemoRunning] = useState(false)
  const { elapsedSeconds, nowTick } = useSessionClock()
  const { runtimeHealth, healthRef, refreshRuntime } = useRuntimeHealth()
  const [asrBusy, setAsrBusy] = useState(false)
  const [ttsBusy, setTtsBusy] = useState(false)
  const busyRef = useRef(false)
  const speakerOnRef = useRef(speakerOn)
  const flowModelRef = useRef<ActiveModel>(null)
  const idleTimerRef = useRef<number | null>(null)
  const highlightTimerRef = useRef<number | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const speechTokenRef = useRef(0)
  const demoRunningRef = useRef(false)
  const demoStopRef = useRef(false)
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
  }, [notify, resetTraces, stopMic, stopSpeech])

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




