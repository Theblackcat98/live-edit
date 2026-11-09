import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BBoxTarget,
  ContextUsage,
  ExecutionDiff,
  Message,
  PipelineStage,
  RejectedTraceRecord,
  RuntimeHealth,
  RuntimeSource,
  Snapshot,
  SpanTarget,
  StageId,
  StageState,
  Suggestion,
  Toast,
  Trace,
} from '../types'
import { DEMO_SEQUENCE, INITIAL_NOTE, NOTE_PATH, NOTE_TITLE } from '../data/note'
import { speak, stopSpeaking, cleanSpeechText, VoiceRecorder } from '../lib/speech'
import { buildSuggestions } from '../lib/suggestions'
import { loadWorkspaceState, saveWorkspaceState, type PersistedWorkspace } from '../lib/storage'
import { endpointUp, probeRuntime, synthesizeSpeech, transcribeAudio } from '../lib/bridge'
import { estimateTokens, makeId, sleep } from '../lib/utils'
import { runPipelineTurn, type PipelineDeps, type RunResultSnapshot } from '../lib/pipeline'

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
      text: 'Session ready · local runtime · camera frame captured',
      at: now - 800,
    },
    {
      id: makeId('msg'),
      role: 'assistant',
      kind: 'greeting',
      text: "I'm watching the camera and your note. Tell me what to change, or ask me what I see.",
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
  traceOpen: boolean
  openTrace: (id?: string) => void
  closeTrace: () => void
  stage: PipelineStage
  stageStates: Record<StageId, StageState>
  busy: boolean
  span: SpanTarget | null
  bbox: BBoxTarget | null
  diff: ExecutionDiff | null
  contextUsage: ContextUsage
  sourceMode: boolean
  setSourceMode: (value: boolean) => void
  speakerOn: boolean
  toggleSpeaker: () => void
  micOn: boolean
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
  const [span, setSpan] = useState<SpanTarget | null>(null)
  const [bbox, setBBox] = useState<BBoxTarget | null>(null)
  const [diff, setDiff] = useState<ExecutionDiff | null>(null)
  const [flowModel, setFlowModel] = useState<ActiveModel>(null)
  const [speaking, setSpeaking] = useState(false)
  const [speakerOn, setSpeakerOn] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsage>(INITIAL_CONTEXT)
  const [sourceMode, setSourceMode] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const [toast, setToast] = useState<Toast | null>(null)
  const [traceOpen, setTraceOpen] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [demoRunning, setDemoRunning] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [nowTick, setNowTick] = useState(Date.now())
  const [sessionStart] = useState(() => Date.now())
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null)
  const [asrBusy, setAsrBusy] = useState(false)
  const [ttsBusy, setTtsBusy] = useState(false)
  const [rejectedTraces, setRejectedTraces] = useState<RejectedTraceRecord[]>(
    persisted?.rejectedTraces ?? [],
  )

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
  const toastTimerRef = useRef<number | null>(null)
  const toastCounter = useRef(0)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const speechTokenRef = useRef(0)
  const demoRunningRef = useRef(false)
  const demoStopRef = useRef(false)
  const healthRef = useRef<RuntimeHealth | null>(null)
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
  // Debounced workspace persistence — best-effort, never breaks the UI.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveWorkspaceState({ note, snapshots: history, messages, runs, rejectedTraces })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [note, history, messages, runs, rejectedTraces])
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
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - sessionStart) / 1000))
      setNowTick(Date.now())
    }, 1000)
    setElapsedSeconds(Math.floor((Date.now() - sessionStart) / 1000))
    return () => window.clearInterval(timer)
  }, [sessionStart])

  useEffect(() => {
    if (!toast) return
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4600)
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    }
  }, [toast])

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

  const notify = useCallback(
    (title: string, detail?: string, tone: Toast['tone'] = 'neutral') => {
      toastCounter.current += 1
      setToast({ id: toastCounter.current, title, detail, tone })
    },
    [],
  )

  const dismissToast = useCallback(() => setToast(null), [])

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
      setBBox(null)
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
    setSpan(null)
    setBBox(null)
    setDiff(null)
    setSourceMode(false)
    return {
      ok: true,
      message: `Restored “${target.label}”.`,
      snapshot: target,
      note: target.note,
    }
  }, [])

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
      setSpan(null)
      setBBox(null)
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

      // Live path: the Omni model speaks its own reply over /tts (24 kHz WAV).
      if (endpointUp(healthRef.current, 'omni')) {
        setTtsBusy(true)
        const controller = new AbortController()
        ttsAbortRef.current = controller
        void (async () => {
          try {
            const blob = await synthesizeSpeech(clean, { signal: controller.signal })
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
              speak(clean, {
                onStart: () => {
                  if (speechTokenRef.current === token) setSpeaking(true)
                },
                onEnd: () => {
                  if (speechTokenRef.current === token) setSpeaking(false)
                },
              })
            }
            setSpeaking(true)
            await audio.play()
          } catch (error) {
            if (controller.signal.aborted || speechTokenRef.current !== token) return
            // TTS request failed — fall back to the browser voice.
            speak(clean, {
              onStart: () => {
                if (speechTokenRef.current === token) setSpeaking(true)
              },
              onEnd: () => {
                if (speechTokenRef.current === token) setSpeaking(false)
              },
            })
          } finally {
            if (speechTokenRef.current === token) setTtsBusy(false)
          }
        })()
        return
      }

      // Fallback: browser speechSynthesis.
      speak(clean, {
        onStart: () => {
          if (speechTokenRef.current === token) setSpeaking(true)
        },
        onEnd: () => {
          if (speechTokenRef.current === token) setSpeaking(false)
        },
      })
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

  const stopMic = useCallback(() => {
    recorderRef.current?.abort()
    recorderRef.current = null
    setMicOn(false)
  }, [])

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
    asrSourceRef,
    lastVoiceSecondsRef,
    chatAbortRef,
    idleTimerRef,
    traceRef,
    recorderRef,
    setBusy,
    setCommandInput,
    setSourceMode,
    setSpan,
    setBBox,
    setDiff,
    setStage,
    setStageStates,
    setFlowModel,
    setTrace,
    setRuns,
    setMessages,
    setContextUsage,
    setRejectedTraces,
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

  const finishVoiceCapture = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = null
    setMicOn(false)
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
        return
      }
      // Live ASR: LFM3-Omni-2B over /v1/audio/transcriptions.
      const transcript = await transcribeAudio(blob)
      asrSourceRef.current = 'live'
      lastVoiceSecondsRef.current = Number(seconds.toFixed(1))
      await submitCommand(transcript.text, 'voice')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ASR request failed.'
      notify('Omni ASR unavailable', `${message} Type the command instead.`, 'error')
    } finally {
      setAsrBusy(false)
    }
  }, [notify])

  const toggleMic = useCallback(() => {
    // Barge-in: speaking while you talk would fight the microphone.
    stopSpeech()
    if (recorderRef.current) {
      // Manual stop: transcribe what was captured.
      void finishVoiceCapture()
      return
    }
    if (asrBusy) return
    if (busyRef.current) {
      notify('Worker is busy', 'Wait for the current call to finish before speaking.', 'neutral')
      return
    }
    if (!endpointUp(healthRef.current, 'omni')) {
      notify(
        'Omni ASR offline',
        'LFM3-Omni-2B is not answering on :8083 — start it with ./lfm3.sh omni, or type the command.',
        'error',
      )
      return
    }

    void (async () => {
      const recorder = new VoiceRecorder({
        onAutoStop: () => {
          void finishVoiceCapture()
        },
      })
      try {
        await recorder.start()
      } catch {
        notify(
          'Microphone permission denied',
          'Allow microphone access in the browser, or type the command.',
          'error',
        )
        return
      }
      recorderRef.current = recorder
      setMicOn(true)
    })()
  }, [asrBusy, finishVoiceCapture, notify])

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
    setSpan(null)
    setBBox(null)
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
      recorderRef.current?.abort()
      recorderRef.current = null
      ttsAbortRef.current?.abort()
      chatAbortRef.current?.abort()
      stopSpeaking()
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current)
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
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
    traceOpen,
    openTrace,
    closeTrace,
    stage,
    stageStates,
    busy,
    span,
    bbox,
    diff,
    contextUsage,
    sourceMode,
    setSourceMode,
    speakerOn,
    toggleSpeaker,
    micOn,
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
  }
}




