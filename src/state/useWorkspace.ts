import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActionClass,
  BBoxTarget,
  ContextUsage,
  CriticResult,
  D1Answer,
  ExecutionDiff,
  Message,
  PipelineStage,
  RouteDecision,
  RunStatus,
  RuntimeHealth,
  RuntimeSource,
  Snapshot,
  SpanTarget,
  StageId,
  StageState,
  Toast,
  ToolName,
  Trace,
  TraceRuntime,
  WorkerCall,
} from '../types'
import { DEMO_SEQUENCE, INITIAL_NOTE, NOTE_PATH, NOTE_TITLE } from '../data/note'
import { CONVERSATIONAL_SCENE_DESCRIPTION } from '../data/scene'
import { TOOL_BY_NAME } from '../data/tools'
import {
  buildClarification,
  buildPlan,
  conversationalReply,
  critique,
  routeCommand,
  tokenViewForWorker,
  type SupervisorPlan,
} from '../lib/supervisor'
import { buildWorkerCall, buildWorkerMessages, renderToolCallXml } from '../lib/worker'
import { executeTool } from '../lib/tools'
import { parseToolCallXml, type ParsedToolCall } from '../lib/xml'
import { speak, stopSpeaking, VoiceRecorder } from '../lib/speech'
import { sceneFrame } from '../lib/frame'
import {
  chatComplete,
  d1Decide,
  endpointUp,
  probeRuntime,
  transcribeAudio,
  type ChatMessage,
} from '../lib/bridge'
import { clamp, estimateTokens, makeId, sleep, truncate } from '../lib/utils'

const initialNoteTokens = estimateTokens(INITIAL_NOTE)
const INITIAL_CONTEXT: ContextUsage = {
  omni: initialNoteTokens + 620,
  d1: initialNoteTokens * 2 + 1450,
  worker: Math.round(initialNoteTokens * 0.35) + 900,
}

type ActiveModel = 'omni' | 'd1' | 'worker' | null

interface RunResultSnapshot {
  ok: boolean
  message: string
  snapshot?: Snapshot
  note: string
}

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
      animate: false,
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

function makeTrace(command: string, source: 'text' | 'voice' | 'demo', note: string): Trace {
  return {
    id: makeId('run'),
    at: Date.now(),
    command,
    source,
    timings: { route: 0, ground: 0, generate: 0, critic: 0, execute: 0, total: 0 },
    status: 'running',
    outputTokens: 0,
    promptTokens: estimateTokens(note) + 180,
    noteTokensAtStart: estimateTokens(note),
    workerNoteView: '',
  }
}

function ackFor(tool?: ToolName): string {
  switch (tool) {
    case 'edit_text':
      return "On it. I'm locking the target span before the worker writes."
    case 'remove_text':
      return "Before I remove anything, I'm checking the span and the blast radius."
    case 'add_text':
      return "On it. I'm pinning the insertion point against the note outline."
    case 'extract_visual_to_note':
      return "Got it. I'll crop the slide region and bring it into the note."
    default:
      return 'Working on it.'
  }
}

function snapshotExcerpt(value: string): string {
  return value
    .replace(/^\s*[-*•–—]\s+/, '')
    .replace(/^\|+\s*/, '')
    .replace(/\s*\|+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function snapshotLabel(tool: ToolName, plan: ReturnType<typeof buildPlan>): string {
  if (tool === 'edit_text') {
    return `Edit · ${truncate(snapshotExcerpt(plan.span?.excerpt ?? 'span'), 32)}`
  }
  if (tool === 'remove_text') {
    return `Remove · ${truncate(snapshotExcerpt(plan.span?.excerpt ?? 'span'), 30)}`
  }
  if (tool === 'add_text') return `Add · ${plan.addAnchor ?? 'document tail'}`
  return `Extract · ${plan.bbox?.label ?? 'visual ROI'}`
}

function humanizeEditValue(value: string): string {
  if (value.trim().startsWith('|')) {
    const cells = value
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
    return cells.join(' · ')
  }
  return value
}

function completionFor(
  tool: ToolName,
  plan: ReturnType<typeof buildPlan>,
  executionMessage: string,
): string {
  if (tool === 'edit_text') {
    return `Done. ${executionMessage} ${
      plan.newText ? `The target now reads “${truncate(humanizeEditValue(plan.newText), 90)}”. ` : ''
    }The snapshot is in the history rail.`
  }
  if (tool === 'remove_text') {
    return `Removed. ${executionMessage} I kept the surrounding structure intact; snapshot rollback is one word away.`
  }
  if (tool === 'add_text') {
    return `Added. ${executionMessage} The insertion stayed inside the supervisor's anchor.`
  }
  return `Done — I pulled the ${plan.bbox?.label ?? 'visual region'} from the camera frame and inserted it under “${plan.anchorHeading}”. The source visual was not modified.`
}

function contextAfterMutation(
  previous: ContextUsage,
  noteAfter: string,
  command: string,
  plan: SupervisorPlan,
  call: WorkerCall,
  liveUsage: Partial<ContextUsage>,
): ContextUsage {
  return {
    omni:
      liveUsage.omni ??
      clamp(previous.omni + 150 + Math.round(estimateTokens(command) / 2), 1200, 30000),
    d1: liveUsage.d1 ?? clamp(5200 + estimateTokens(noteAfter) + 900, 4500, 120000),
    worker:
      liveUsage.worker ??
      clamp(
        1400 + call.rawTokens * 2 + estimateTokens(plan.span?.excerpt ?? '') + (plan.bbox ? 900 : 0),
        1800,
        120000,
      ),
  }
}

// --- native bridge glue -------------------------------------------------------

const ACTION_CLASSES: ActionClass[] = ['conversational_only', 'file_mutation', 'ambiguous_request']
const ROUTE_TOOLS: ToolName[] = ['edit_text', 'remove_text', 'add_text', 'extract_visual_to_note']

const ROUTE_QUESTIONS = {
  action: {
    type: 'choice' as const,
    instructions:
      'Classify what the speaker wants relative to the note file and the attached slide.',
    criteria: {
      conversational_only:
        'a question, status request, greeting or small talk — the note file must not change',
      file_mutation: 'an instruction to change the note file (add, edit, remove or extract content)',
      ambiguous_request:
        'a mutation verb, but the target object is missing or refers vaguely to "that" or "it"',
    },
  },
  tool: {
    type: 'choice' as const,
    instructions: 'If the note file should change, which tool fits the command best?',
    criteria: {
      edit_text: 'replace existing lines with new text',
      remove_text: 'delete lines, a bullet or a table row',
      add_text: 'insert new content at a position or under a heading',
      extract_visual_to_note: 'read the visible slide and copy its content into the note',
    },
  },
}

const CRITIC_QUESTIONS = {
  sound: {
    type: 'noul' as const,
    instructions:
      'Is the proposed tool call correct and safe to execute on the grounded span? The replacement must preserve the note structure and the anchor must match the current lines.',
  },
}

export function routeFromAnswers(answers: Record<string, D1Answer>): RouteDecision | null {
  const actionAnswer = answers.action
  if (!actionAnswer || actionAnswer.type !== 'choice') return null
  const action = actionAnswer.choice
  if (!action || !ACTION_CLASSES.includes(action as ActionClass)) return null

  const toolAnswer = answers.tool
  const probabilities =
    toolAnswer && toolAnswer.type === 'choice' ? (toolAnswer.probabilities ?? {}) : {}
  const ranked = ROUTE_TOOLS.map((name) => ({ name, p: probabilities[name] ?? 0 })).sort(
    (a, b) => b.p - a.p,
  )
  const best = ranked[0]
  if (action !== 'conversational_only' && (!best || best.p <= 0)) return null

  const primaryTool = action === 'conversational_only' ? undefined : best.name
  const allowedTools =
    action === 'file_mutation'
      ? ranked
          .filter((tool) => tool.p > 0.02)
          .map((tool) => ({ name: tool.name, p: Number(tool.p.toFixed(3)) }))
      : []

  return {
    action: action as ActionClass,
    actionConfidence: Number((actionAnswer.probabilities?.[action] ?? 0.9).toFixed(3)),
    allowedTools,
    primaryTool,
    reason: `d1-Omni-2B typed decision over /v1/systemone: ${action}.`,
  }
}

function buildChatMessages(
  command: string,
  note: string,
  lastRun: { command: string; status: string; executionMessage?: string } | null,
  imageDataUrl: string | null,
): ChatMessage[] {
  const system = [
    'You are Omni, the live interface of a local-first multimodal note workspace.',
    'You watch the operating-review slide and the note the user is editing.',
    'Reply conversationally in one to three sentences, grounded in what you actually see or the note content.',
    'This is a conversational turn only: never claim to have edited the note. Edits run through a separate grounded pipeline.',
  ].join(' ')

  const textParts = [
    imageDataUrl
      ? 'Attached is the current operating-review slide frame.'
      : `Scene: ${CONVERSATIONAL_SCENE_DESCRIPTION}`,
    `Current note (${NOTE_PATH}):\n${truncate(note, 3600)}`,
    lastRun
      ? `Last completed run: "${lastRun.command}" → ${lastRun.status}${
          lastRun.executionMessage ? ` (${lastRun.executionMessage})` : ''
        }`
      : 'No edits have been committed yet this session.',
    `User: ${command}`,
  ].join('\n\n')

  const content: ChatMessage['content'] = imageDataUrl
    ? [
        { type: 'text', text: textParts },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : textParts
  return [
    { role: 'system', content: system },
    { role: 'user', content },
  ]
}

function buildCriticState(
  command: string,
  plan: SupervisorPlan,
  call: WorkerCall,
  note: string,
): string {
  const lines: string[] = [`User command: ${command}`]
  if (plan.span) {
    lines.push(
      `Grounded span: lines ${plan.span.startLine}–${plan.span.endLine} · confidence ${plan.span.confidence.toFixed(2)}`,
      `Current span text: "${plan.span.excerpt}"`,
    )
  }
  if (plan.bbox) lines.push(`ROI: ${plan.bbox.label} · confidence ${plan.bbox.confidence.toFixed(2)}`)
  lines.push(
    'Proposed tool call:',
    JSON.stringify({ name: call.name, arguments: call.params }, null, 2),
    `Note around the span:\n${truncate(note, 1800)}`,
  )
  return lines.join('\n')
}

function liveWorkerCall(
  parsed: ParsedToolCall,
  reasoning: string,
  rawText: string,
  ms: number,
  usagePromptTokens: number,
  usageOutputTokens: number,
  plan: SupervisorPlan,
  note: string,
): WorkerCall {
  const promptHints: string[] = [
    `Decoded by LFM3-VL-2B · ${(ms / 1000).toFixed(1)}s · ${usagePromptTokens} prompt tokens`,
  ]
  if (plan.span) {
    promptHints.push(
      `Target span: lines ${plan.span.startLine}–${plan.span.endLine} · P=${plan.span.confidence.toFixed(2)}`,
      `Exact anchor: ${truncate(plan.span.excerpt, 80)}`,
    )
  }
  if (plan.bbox) {
    promptHints.push(`ROI crop: ${plan.bbox.label} · P=${plan.bbox.confidence.toFixed(2)}`)
  }
  if (plan.anchorHeading) promptHints.push(`Anchor heading: ${plan.anchorHeading}`)
  promptHints.push('Line-numbered note window injected; full file withheld')

  return {
    name: parsed.name,
    params: parsed.params,
    thought: parsed.think ?? reasoning ?? `Worker emitted ${parsed.name} from the grounded hints.`,
    xml: renderToolCallXml(parsed.name, parsed.params),
    rawTokens: usageOutputTokens || estimateTokens(rawText),
    promptHints,
    toolSchemasInjected: 1,
    noteView: tokenViewForWorker(note, plan.span, null),
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

  const [note, setNote] = useState(INITIAL_NOTE)
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [history, setHistory] = useState<Snapshot[]>(() => [initialSnapshotRef.current as Snapshot])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [trace, setTrace] = useState<Trace | null>(null)
  const [runs, setRuns] = useState<Trace[]>([])
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

  const noteRef = useRef(note)
  const historyRef = useRef(history)
  const historyIndexRef = useRef(historyIndex)
  const runsRef = useRef<Trace[]>([])
  const traceRef = useRef<Trace | null>(null)
  const busyRef = useRef(false)
  const speakerOnRef = useRef(speakerOn)
  const flowModelRef = useRef<ActiveModel>(null)
  const speakingRef = useRef(false)
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

  useEffect(() => {
    noteRef.current = note
  }, [note])
  useEffect(() => {
    historyRef.current = history
  }, [history])
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
    speakingRef.current = speaking
  }, [speaking])

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

  const speakReply = useCallback((text: string) => {
    if (!speakerOnRef.current) return
    speechTokenRef.current += 1
    const token = speechTokenRef.current
    speak(text, {
      onStart: () => {
        if (speechTokenRef.current === token) setSpeaking(true)
      },
      onEnd: () => {
        if (speechTokenRef.current === token) setSpeaking(false)
      },
    })
  }, [])

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

  async function submitCommand(
    rawCommand: string,
    source: 'text' | 'voice' | 'demo' = 'text',
  ): Promise<void> {
    const command = rawCommand.trim()
    if (!command) return
    if (busyRef.current) {
      notify('Worker is busy', 'Wait for the current verified call to finish before queuing another.', 'neutral')
      return
    }

    busyRef.current = true
    setBusy(true)
    setCommandInput('')
    setSourceMode(false)
    if (recorderRef.current) stopMic()
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    clearTransientHighlights()
    setDiff(null)
    setSpan(null)
    setBBox(null)
    setStage('routing')
    setStageStates({ A: 'running', B: 'idle', C: 'idle' })
    setFlowModel('d1')
    if (speakingRef.current) {
      speechTokenRef.current += 1
      stopSpeaking()
      setSpeaking(false)
    }

    const noteAtStart = noteRef.current
    const traceLocal = makeTrace(command, source, noteAtStart)
    setTrace(traceLocal)
    traceRef.current = traceLocal
    addMessage({
      role: 'user',
      text: command,
      source,
      durationSec: source === 'text' ? undefined : lastVoiceSecondsRef.current,
    })

    let closed = false
    const publish = () => {
      const copy: Trace = {
        ...traceLocal,
        timings: { ...traceLocal.timings },
      }
      setTrace(copy)
      traceRef.current = copy
    }
    const finish = (status: RunStatus) => {
      if (closed) return
      closed = true
      traceLocal.status = status
      traceLocal.timings.total = Number(
        (
          traceLocal.timings.route +
          traceLocal.timings.ground +
          traceLocal.timings.generate +
          traceLocal.timings.critic +
          traceLocal.timings.execute
        ).toFixed(1),
      )
      const finished: Trace = { ...traceLocal, timings: { ...traceLocal.timings } }
      setTrace(finished)
      traceRef.current = finished
      runsRef.current = [finished, ...runsRef.current].slice(0, 24)
      setRuns(runsRef.current)
      setStage('complete')
      setFlowModel(null)
      setBusy(false)
      busyRef.current = false
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = window.setTimeout(() => {
        setStage((current) => (current === 'complete' ? 'idle' : current))
        idleTimerRef.current = null
      }, 1700)
    }

    const runtime: TraceRuntime = {
      route: 'fallback',
      worker: 'fallback',
      critic: 'fallback',
      chat: 'fallback',
    }
    if (source === 'voice') runtime.asr = asrSourceRef.current
    asrSourceRef.current = 'fallback'
    traceLocal.runtime = runtime
    traceLocal.frameSource = 'synthetic-slide'
    const liveUsage: Partial<ContextUsage> = {}

    try {
      await sleep(220)

      // --- A · route ------------------------------------------------------
      // Live path: d1-Omni-2B classifies the command over /v1/systemone in one
      // forward pass (watching the slide frame). Fallback: local heuristics.
      let route: RouteDecision | null = null
      if (endpointUp(healthRef.current, 'd1omni')) {
        try {
          const frame = await sceneFrame('full').catch(() => null)
          const decision = await d1Decide({
            state: [
              `User command: ${command}`,
              `Note (${NOTE_PATH}):\n${truncate(noteAtStart, 2400)}`,
            ].join('\n'),
            imageDataUrl: frame ?? undefined,
            questions: ROUTE_QUESTIONS,
          })
          const decided = routeFromAnswers(decision.answers)
          if (decided) {
            route = decided
            runtime.route = 'live'
            traceLocal.timings.route = decision.ms
            if (decision.usage.promptTokens) {
              traceLocal.promptTokens = decision.usage.promptTokens
              liveUsage.d1 = decision.usage.promptTokens
            }
          }
        } catch {
          route = null
        }
      }
      if (!route) {
        const routeStarted = performance.now()
        route = routeCommand(command)
        traceLocal.timings.route = Number((performance.now() - routeStarted).toFixed(1))
      }
      traceLocal.route = route
      publish()
      setStageStates({ A: 'done', B: 'idle', C: 'idle' })

      if (route.directive) {
        setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
        setStage('executing')
        setFlowModel(null)
        const directiveStarted = performance.now()
        const delta = route.directive === 'undo' ? -1 : 1
        const restored = restoreHistory(historyIndexRef.current + delta)
        traceLocal.timings.execute = Number((performance.now() - directiveStarted).toFixed(1))
        if (!restored.ok) {
          traceLocal.status = 'conversational'
          addMessage({
            role: 'assistant',
            kind: 'result',
            text:
              route.directive === 'undo'
                ? 'There is nothing to undo yet — the note is at its first snapshot.'
                : 'There is nothing to redo. The note is already at the latest snapshot.',
            animate: true,
          })
          setContextUsage((previous) => ({
            ...previous,
            omni: clamp(previous.omni + 90, 1200, 30000),
          }))
          finish('conversational')
          return
        }
        traceLocal.execution = {
          ok: true,
          message: restored.message,
          tool: route.directive,
          note: restored.note,
          durationMs: traceLocal.timings.execute,
          snapshotId: restored.snapshot?.id,
        }
        publish()
        const confirmation =
          route.directive === 'undo'
            ? `Reverted to “${restored.snapshot?.label}”. The note is back to the previous verified snapshot — no model inference needed.`
            : `Reapplied “${restored.snapshot?.label}”. Snapshot ${historyIndexRef.current} is active again.`
        addMessage({
          role: 'assistant',
          kind: 'result',
          text: confirmation,
          animate: true,
          runId: traceLocal.id,
        })
        setContextUsage((previous) => ({
          ...previous,
          omni: clamp(previous.omni + 120, 1200, 30000),
          d1: clamp(5200 + estimateTokens(restored.note) + 900, 4500, 120000),
        }))
        speakReply(confirmation)
        finish('verified')
        return
      }

      if (route.action === 'conversational_only') {
        setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
        const last = runsRef.current[0]
        const lastRun = last
          ? {
              command: last.command,
              status: last.status,
              executionMessage: last.execution?.message,
            }
          : null
        let reply: string | null = null
        // Live path: LFM3-Omni-2B over /v1/chat/completions, watching the slide.
        if (endpointUp(healthRef.current, 'omni')) {
          try {
            const frame = await sceneFrame('full').catch(() => null)
            const completion = await chatComplete(
              'omni',
              buildChatMessages(command, noteAtStart, lastRun, frame),
              { temperature: 0.3, maxTokens: 500 },
            )
            reply = completion.text
            runtime.chat = 'live'
            traceLocal.outputTokens = completion.usage.outputTokens || estimateTokens(reply)
            if (completion.usage.promptTokens) {
              traceLocal.promptTokens = completion.usage.promptTokens
              liveUsage.omni = completion.usage.promptTokens
            }
          } catch {
            reply = null
          }
        }
        if (!reply) {
          // Fallback: deterministic local templates.
          reply = conversationalReply(command, noteAtStart, lastRun)
          traceLocal.outputTokens = estimateTokens(reply)
          setContextUsage((previous) => ({
            ...previous,
            omni: clamp(
              previous.omni + 120 + Math.round(estimateTokens(command) / 2),
              1200,
              30000,
            ),
          }))
        }
        addMessage({
          role: 'assistant',
          kind: 'result',
          text: reply,
          animate: true,
          runId: traceLocal.id,
        })
        publish()
        speakReply(reply)
        finish('conversational')
        return
      }

      if (route.action === 'ambiguous_request') {
        setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
        const clarification = buildClarification(
          noteAtStart,
          command,
          route.primaryTool ?? 'edit_text',
          'ambiguous',
        )
        traceLocal.outputTokens = estimateTokens(clarification.text)
        addMessage({
          role: 'assistant',
          kind: 'clarify',
          text: clarification.text,
          actions: clarification.actions,
          animate: true,
          runId: traceLocal.id,
        })
        setContextUsage((previous) => ({
          ...previous,
          omni: clamp(previous.omni + 100, 1200, 30000),
        }))
        publish()
        speakReply(clarification.text)
        finish('clarify')
        return
      }

      if (!route || !route.primaryTool) {
        throw new Error('Supervisor returned no tool for a mutation turn.')
      }
      let effectiveRoute: RouteDecision = route

      setStage('grounding')
      setStageStates({ A: 'done', B: 'running', C: 'idle' })
      setFlowModel('d1')
      // Deterministic local span search over the note (exact quotes, line
      // numbers, headings, keywords). Not a model call — this is real code.
      const groundStarted = performance.now()
      let plan = buildPlan(command, effectiveRoute, noteAtStart)
      // d1's tool pick can fail to ground (e.g. add_text chosen for an update
      // command). Retry the runner-up tools from d1's own distribution before
      // falling back to a clarification, and record the repair in the reason.
      if (plan.problem && effectiveRoute.primaryTool) {
        const failedTool = effectiveRoute.primaryTool
        const alternatives = effectiveRoute.allowedTools
          .filter((tool) => tool.p > 0.2 && tool.name !== failedTool)
          .sort((a, b) => b.p - a.p)
        for (const alternative of alternatives) {
          const retryPlan = buildPlan(
            command,
            { ...effectiveRoute, primaryTool: alternative.name },
            noteAtStart,
          )
          if (!retryPlan.problem) {
            effectiveRoute = {
              ...effectiveRoute,
              primaryTool: alternative.name,
              reason: `${effectiveRoute.reason} · grounded as ${alternative.name} after ${failedTool} found no target`,
            }
            plan = retryPlan
            break
          }
        }
      }
      if (!effectiveRoute.primaryTool) {
        throw new Error('Supervisor returned no tool for a mutation turn.')
      }
      traceLocal.route = effectiveRoute
      traceLocal.timings.ground = Number((performance.now() - groundStarted).toFixed(1))
      if (traceLocal.timings.ground < 180) await sleep(180 - traceLocal.timings.ground)

      const acknowledgement = ackFor(effectiveRoute.primaryTool)
      addMessage({
        role: 'assistant',
        kind: 'ack',
        text: acknowledgement,
        animate: true,
        runId: traceLocal.id,
      })
      speakReply(acknowledgement)

      if (plan.span) {
        traceLocal.span = plan.span
        setSpan(plan.span)
      }
      if (plan.bbox) {
        traceLocal.bbox = plan.bbox
        setBBox(plan.bbox)
      }
      publish()
      setStageStates({ A: 'done', B: 'done', C: 'idle' })

      if (plan.problem) {
        const clarification = buildClarification(
          noteAtStart,
          command,
          effectiveRoute.primaryTool,
          plan.problem,
          plan.problemDetail,
        )
        setStageStates({ A: 'done', B: 'done', C: 'skipped' })
        traceLocal.outputTokens = estimateTokens(clarification.text)
        addMessage({
          role: 'assistant',
          kind: 'clarify',
          text: clarification.text,
          actions: clarification.actions,
          animate: true,
          runId: traceLocal.id,
        })
        setContextUsage((previous) => ({
          ...previous,
          omni: clamp(previous.omni + 110, 1200, 30000),
        }))
        publish()
        speakReply(clarification.text)
        finish('clarify')
        return
      }

      const templateCall = buildWorkerCall(command, effectiveRoute, plan, noteAtStart)
      const delegation = {
        runId: traceLocal.id,
        tool: effectiveRoute.primaryTool,
        status: 'generating' as const,
        thought:
          templateCall?.thought ??
          'VL worker is decoding the grounded hints into one XML tool call.',
      }
      const delegationId = addMessage({
        role: 'tool',
        text: '',
        delegation,
      })

      setStage('generating')
      setStageStates({ A: 'done', B: 'done', C: 'idle' })
      setFlowModel('worker')

      // Live path: LFM3-VL-2B emits the XML tool call over /v1/chat/completions,
      // with the ROI crop attached for visual extraction. Fallback: template.
      let call: WorkerCall | null = null
      if (endpointUp(healthRef.current, 'vl')) {
        try {
          const frame =
            effectiveRoute.primaryTool === 'extract_visual_to_note'
              ? await sceneFrame(plan.bbox?.region ?? 'full').catch(() => null)
              : null
          const messages = buildWorkerMessages(command, route, plan, noteAtStart, frame)
          const completion = await chatComplete('vl', messages, {
            temperature: 0.1,
            maxTokens: 700,
          })
          const rawText = completion.text
          const xmlInput = /<think>/.test(rawText)
            ? rawText
            : completion.reasoning
              ? `<think>${completion.reasoning}</think>\n${rawText}`
              : rawText
          const parsed = parseToolCallXml(xmlInput)
          const required = parsed
            ? TOOL_BY_NAME[parsed.name].params
                .filter((param) => param.required)
                .map((param) => param.name)
            : []
          const complete =
            parsed &&
            parsed.name === effectiveRoute.primaryTool &&
            required.every((name) => (parsed.params[name] ?? '').length > 0)
          if (parsed && complete) {
            call = liveWorkerCall(
              parsed,
              completion.reasoning,
              rawText,
              completion.ms,
              completion.usage.promptTokens,
              completion.usage.outputTokens,
              plan,
              noteAtStart,
            )
            runtime.worker = 'live'
            traceLocal.timings.generate = completion.ms
            traceLocal.outputTokens = call.rawTokens
            if (completion.usage.promptTokens) {
              traceLocal.promptTokens = completion.usage.promptTokens
              liveUsage.worker = completion.usage.promptTokens
            }
            patchMessage(delegationId, {
              delegation: { ...delegation, thought: call.thought },
            })
          }
        } catch {
          call = null
        }
      }
      if (!call) {
        if (!templateCall) throw new Error('Worker could not build a call from supervisor hints.')
        call = templateCall
        traceLocal.timings.generate = 0.2
        if (traceLocal.timings.generate < 240) await sleep(240)
      }
      traceLocal.call = call
      traceLocal.workerNoteView = call.noteView
      if (!traceLocal.promptTokens || traceLocal.promptTokens < estimateTokens(noteAtStart)) {
        traceLocal.promptTokens =
          estimateTokens(`${call.noteView}\n${call.promptHints.join('\n')}`) + 180
      }
      publish()

      setStage('verifying')
      setStageStates({ A: 'done', B: 'done', C: 'running' })
      setFlowModel('d1')
      // Local deterministic checks are hard gates (anchor exactness, blast
      // radius, range bounds). When they pass and d1-Omni is up, its semantic
      // pass answers one zero-token question over /v1/systemone.
      const criticStarted = performance.now()
      let critic: CriticResult = critique(noteAtStart, effectiveRoute, plan.span, call)
      if (critic.verdict === 'verified' && endpointUp(healthRef.current, 'd1omni')) {
        try {
          const decision = await d1Decide({
            state: buildCriticState(command, plan, call, noteAtStart),
            questions: CRITIC_QUESTIONS,
          })
          const answer = decision.answers.sound
          if (answer && answer.type === 'noul') {
            const accepted = answer.noul >= 0.5
            critic = {
              ...critic,
              pCorrect: clamp(answer.noul, 0.01, 0.99),
              verdict: accepted ? 'verified' : 'rejected',
              feedback: accepted
                ? critic.feedback
                : 'd1 semantic pass rejected the call; the note was not touched.',
            }
            runtime.critic = 'live'
            traceLocal.timings.critic = decision.ms
            if (decision.usage.promptTokens) {
              traceLocal.promptTokens = decision.usage.promptTokens
              liveUsage.d1 = decision.usage.promptTokens
            }
          }
        } catch {
          // d1 unreachable or malformed answer — the local verdict stands.
        }
      }
      if (runtime.critic !== 'live') {
        const criticElapsed = Number((performance.now() - criticStarted).toFixed(1))
        traceLocal.timings.critic = criticElapsed
        if (criticElapsed < 150) await sleep(150 - criticElapsed)
      }
      traceLocal.critic = critic
      publish()

      if (critic.verdict === 'rejected') {
        setStageStates({ A: 'done', B: 'done', C: 'failed' })
        patchMessage(delegationId, {
          delegation: { ...delegation, status: 'rejected' },
        })
        const rejection =
          'I paused before execution. The supervisor rejected the proposed tool call, so the note was not touched. Open the trace to see which check failed.'
        traceLocal.status = 'rejected'
        addMessage({
          role: 'assistant',
          kind: 'error',
          text: rejection,
          animate: true,
          runId: traceLocal.id,
        })
        notify('Call rejected by d1', 'No lines were written. The trace has the critic feedback.', 'error')
        speakReply(rejection)
        finish('rejected')
        return
      }

      setStageStates({ A: 'done', B: 'done', C: 'done' })
      patchMessage(delegationId, {
        delegation: { ...delegation, status: 'verified', confidence: critic.pCorrect },
      })
      setStage('executing')
      setFlowModel('worker')

      const execStarted = performance.now()
      const parsed = parseToolCallXml(call.xml)
      if (!parsed || parsed.name !== call.name) {
        throw new Error('The worker XML did not round-trip through the tool parser.')
      }
      const execution = executeTool(noteAtStart, { ...call, name: parsed.name, params: parsed.params })
      traceLocal.timings.execute = Number((performance.now() - execStarted).toFixed(1))
      traceLocal.execution = execution
      publish()

      if (!execution.ok) {
        setStageStates({ A: 'done', B: 'done', C: 'done' })
        patchMessage(delegationId, {
          delegation: { ...delegation, status: 'rejected', confidence: critic.pCorrect },
        })
        traceLocal.status = 'failed'
        addMessage({
          role: 'assistant',
          kind: 'error',
          text: `I stopped before writing. ${execution.message} The note was not changed.`,
          animate: true,
          runId: traceLocal.id,
        })
        notify('Execution stopped', execution.message, 'error')
        finish('failed')
        return
      }

      let newNote = noteAtStart
      if (execution.diff) {
        const snapshot = commitNote(
          execution.note,
          snapshotLabel(call.name, plan),
          call.name,
        )
        execution.snapshotId = snapshot.id
        newNote = execution.note
        traceLocal.execution = execution
        setDiff(execution.diff)
        setSpan(null)
      } else {
        setSpan(null)
      }
      patchMessage(delegationId, {
        delegation: { ...delegation, status: 'executed', confidence: critic.pCorrect },
      })
      traceLocal.status = 'verified'
      setContextUsage((previous) =>
        contextAfterMutation(previous, newNote, command, plan, call, liveUsage),
      )
      const completion = completionFor(call.name, plan, execution.message)
      addMessage({
        role: 'assistant',
        kind: 'result',
        text: completion,
        animate: true,
        runId: traceLocal.id,
      })
      publish()
      speakReply(completion)
      finish('verified')
      scheduleHighlightClear()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown orchestrator failure.'
      if (!closed) {
        traceLocal.status = 'failed'
        addMessage({
          role: 'assistant',
          kind: 'error',
          text: `I stopped the run: ${message} Nothing was written to the note.`,
          animate: true,
        })
        notify('Run stopped', message, 'error')
        finish('failed')
      }
    } finally {
      if (busyRef.current) {
        busyRef.current = false
        setBusy(false)
        setStage('idle')
        setFlowModel(null)
      }
    }
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
