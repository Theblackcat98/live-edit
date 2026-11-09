import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BBoxTarget,
  ContextUsage,
  CriticResult,
  ExecutionDiff,
  FrameSource,
  Message,
  PipelineStage,
  Probability,
  ResolvedFrame,
  RouteDecision,
  RunStatus,
  RuntimeHealth,
  RuntimeSource,
  RejectedTraceRecord,
  Snapshot,
  SpanTarget,
  StageId,
  StageState,
  Suggestion,
  Toast,
  ToolName,
  Trace,
  TraceRuntime,
  WorkerCall,
  WorkerSampler,
} from '../types'
import { DEMO_SEQUENCE, INITIAL_NOTE, NOTE_PATH, NOTE_TITLE } from '../data/note'
import { TOOL_BY_NAME } from '../data/tools'
import {
  buildClarification,
  buildPlan,
  conversationalReply,
  critique,
  isVagueMutation,
  resolveGroundingSpan,
  ROUTE_QUESTIONS,
  routeCommand,
  tokenViewForWorker,
  type SupervisorPlan,
} from '../lib/supervisor'
import { buildWorkerCall, buildWorkerMessages, renderToolCallXml } from '../lib/worker'
import { routeFromAnswers } from '../lib/route'
import { executeTool } from '../lib/tools'
import { parseToolCallXml, type ParsedToolCall } from '../lib/xml'
import { speak, stopSpeaking, cleanSpeechText, VoiceRecorder } from '../lib/speech'
import { currentSceneSource, resolveSceneFrame } from '../lib/frame'
import { buildSuggestions } from '../lib/suggestions'
import { loadWorkspaceState, saveWorkspaceState, type PersistedWorkspace } from '../lib/storage'
import {
  chatComplete,
  chatCompleteStream,
  d1Decide,
  endpointUp,
  probeRuntime,
  synthesizeSpeech,
  transcribeAudio,
  type ChatMessage,
  type ChatOptions,
} from '../lib/bridge'
import { clamp, estimateTokens, makeId, pAdopted, pFloor, sleep, truncate } from '../lib/utils'

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

const CRITIC_QUESTIONS = {
  sound: {
    type: 'noul' as const,
    instructions:
      'Is the proposed tool call correct and safe to execute on the grounded span? The replacement must preserve the note structure and the anchor must match the current lines.',
  },
}

/**
 * Recent (user command, assistant reply) pairs replayed as chat turns.
 * `reply` is absent when the workspace answered with a pipeline template
 * (clarify/ack): that canned wording is not conversation, and a small model
 * imitates it verbatim on later turns instead of answering, so only the
 * command is replayed for those turns.
 */
interface ChatTurn {
  command: string
  reply?: string
}

/** How many prior turns the conversational model sees. */
const CHAT_MEMORY_TURNS = 6

/** Workspace-authored replies that are pipeline templates, not conversation. */
const TEMPLATE_REPLY_KINDS: Array<NonNullable<Message['kind']>> = ['clarify', 'ack']

/**
 * Pair each user message with the last assistant reply before the next user
 * message. A trailing user turn (the command being submitted) has no reply yet
 * and is therefore never replayed as history.
 */
function conversationTurns(messages: Message[], limit: number): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'user' || !message.text.trim()) continue
    let reply: Message | null = null
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor]
      if (candidate.role === 'user') break
      if (candidate.role === 'assistant' && candidate.text.trim()) reply = candidate
    }
    const templated = reply?.kind ? TEMPLATE_REPLY_KINDS.includes(reply.kind) : false
    turns.push({
      command: message.text,
      reply: reply && !templated ? reply.text : undefined,
    })
  }
  return turns.slice(-limit)
}

const FRAME_DESCRIPTIONS: Record<FrameSource, string> = {
  'live-camera': 'Attached is the current live frame from the device camera.',
  'live-screen': 'Attached is the current live frame from the screen share.',
  'synthetic-slide':
    'Attached is the synthetic operating-review slide frame (no live capture is attached).',
  none: 'No frame is attached for this turn.',
}

/**
 * Turns actually about the document get its full text; small talk does not.
 * A 3,600-character dump on every turn dilutes a 2B model's attention and
 * biases it into describing the note unasked.
 */
const NOTE_QUESTION =
  /\b(note|notes|document|doc|section|table|heading|paragraph|bullet|line|lines|read it|what does it say|content|says|text)\b/i

/** Title plus the first H2 headings as a one-line outline, no full dump. */
function noteOutline(note: string): string {
  const headings: string[] = []
  for (const line of note.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    headings.push(match[1])
    if (headings.length >= 8) break
  }
  return headings.length > 0 ? `${NOTE_TITLE} · ${headings.join(' · ')}` : NOTE_TITLE
}

/**
 * Omni has no tools, but a 2B model still improvises tool-call text on edit
 * requests. Strip those artifacts before the reply is shown or spoken; an
 * all-artifact reply becomes empty and falls through to the template.
 */
function sanitizeOmniText(text: string): string {
  let clean = text.replace(/```[^\n]*\n[\s\S]*?```/g, (block) =>
    /tool_call|function=/i.test(block) ? ' ' : block,
  )
  // Unterminated fence at the end of a truncated stream.
  clean = clean.replace(/```[^\n]*\n[\s\S]*$/g, (block) =>
    /tool_call|function=/i.test(block) ? ' ' : block,
  )
  clean = clean.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ')
  clean = clean.replace(/<tool_call>[\s\S]*$/i, ' ')
  clean = clean.replace(/<function=[\s\S]*?<\/function>/gi, ' ')
  clean = clean.replace(/<function=[^>]*>/gi, ' ')
  return clean.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function buildChatMessages(
  command: string,
  note: string,
  lastRun: { command: string; status: string; executionMessage?: string } | null,
  turns: ChatTurn[],
  frame: ResolvedFrame | null,
): ChatMessage[] {
  const system = [
    'You are Omni — the conversational interface of a local multimodal note workspace.',
    'You have no tools. You cannot edit files, read tool output or run anything: a separate worker pipeline performs every file edit.',
    'Never emit XML, JSON or code blocks as actions. A <tool_call>, a <function=…> fragment, or a fenced block is never an action here — the UI strips it as noise. Do not use them.',
    'If the user asks for a note change, reply in ONE short sentence acknowledging that the edit pipeline takes it from here, e.g. "On it — the edit pipeline will handle that." Never promise details you cannot know (exact text, line numbers, results) and never claim something was already edited.',
    'Style: brief and natural, one or two sentences unless more is genuinely needed.',
    'Greetings, thanks and small talk: answer like a person — "Hey!", "Anytime." — and do NOT describe the note, the frame, or any statuses unless the user explicitly asks about them.',
    'Reference the note or the attached frame only when the question is actually about them. When asked what you can see, describe the attached frame itself — camera or screen captures are real scenes, not documents.',
  ].join(' ')

  const textParts = [
    frame ? FRAME_DESCRIPTIONS[frame.source] : FRAME_DESCRIPTIONS.none,
    NOTE_QUESTION.test(command)
      ? `Current note (${NOTE_PATH}):\n${truncate(note, 3600)}`
      : `Current note (${NOTE_PATH}) outline: ${noteOutline(note)}`,
    lastRun
      ? `Last completed run: "${lastRun.command}" → ${lastRun.status}${
          lastRun.executionMessage ? ` (${lastRun.executionMessage})` : ''
        }`
      : 'No edits have been committed yet this session.',
    `User: ${command}`,
  ].join('\n\n')

  const content: ChatMessage['content'] = frame
    ? [
        { type: 'text', text: textParts },
        { type: 'image_url', image_url: { url: frame.dataUrl } },
      ]
    : textParts
  return [
    { role: 'system', content: system },
    ...turns.flatMap((turn): ChatMessage[] => {
      const user: ChatMessage = { role: 'user', content: truncate(turn.command, 600) }
      if (!turn.reply) return [user]
      return [user, { role: 'assistant', content: truncate(turn.reply, 600) }]
    }),
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
      `Grounded span: lines ${plan.span.startLine}–${plan.span.endLine} · confidence ${
        plan.span.confidence === null ? 'unreported' : plan.span.confidence.toFixed(2)
      }`,
      `Current span text: "${plan.span.excerpt}"`,
    )
  }
  if (plan.bbox) lines.push(`ROI: ${plan.bbox.label} · confidence ${plan.bbox.confidence.toFixed(2)}`)
  lines.push(
    'Proposed tool call:',
    JSON.stringify({ name: call.name, arguments: call.params }, null, 2),
  )
  // An erased document has no text to quote; say so rather than leaving an
  // empty "Note around the span:" block that reads as a missing-anchor fault.
  lines.push(
    note.trim()
      ? `Note around the span:\n${truncate(note, 1800)}`
      : 'The note is currently empty; the proposed call adds new content without replacing or deleting anything.\nNote around the span: (empty document — 0 lines)',
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
  sampler: WorkerSampler,
): WorkerCall {
  const promptHints: string[] = [
    `Decoded by LFM3-1.7B · ${(ms / 1000).toFixed(1)}s · ${usagePromptTokens} prompt tokens`,
    `Sent sampler: temperature=${sampler.temperature} · max_tokens=${sampler.maxTokens}`,
  ]
  if (plan.span) {
    promptHints.push(
      `Target span: lines ${plan.span.startLine}–${plan.span.endLine} · P=${
        plan.span.confidence === null ? 'unreported' : plan.span.confidence.toFixed(2)
      }`,
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
    sampler,
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

  async function submitCommand(
    rawCommand: string,
    source: 'text' | 'voice' | 'demo' = 'text',
  ): Promise<void> {
    const command = rawCommand.trim()
    if (!command) return

    // Barge-in: a new command owns the session. Cut any in-flight chat stream
    // and any spoken audio (model TTS fetch, audio element, browser voice)
    // before this run starts processing.
    chatAbortRef.current?.abort()
    chatAbortRef.current = null
    stopSpeech()

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
          traceLocal.timings.execute +
          (traceLocal.timings.chat ?? 0)
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
    traceLocal.frameSource = 'none'
    const liveUsage: Partial<ContextUsage> = {}

    try {
      await sleep(220)

      // --- A · route ------------------------------------------------------
      // Undo/redo are pipeline directives, not model decisions: snapshot
      // rollback must win even when d1-Omni is live, or a small model reads
      // "undo that" as a file mutation and the run grounds against nothing.
      // Live path: d1-Omni-2B classifies the command over /v1/systemone in one
      // forward pass (watching the current frame). Fallback: local heuristics.
      let route: RouteDecision | null = null
      const localPre = routeCommand(command)
      if (localPre.directive) route = localPre
      if (!route && endpointUp(healthRef.current, 'd1omni')) {
        try {
          const frame = await resolveSceneFrame('full').catch(() => null)
          traceLocal.frameSource = frame?.source ?? 'none'
          const decision = await d1Decide({
            state: [
              `User command: ${command}`,
              `Note (${NOTE_PATH}):\n${truncate(noteAtStart, 2400)}`,
            ].join('\n'),
            imageDataUrl: frame?.dataUrl,
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
      // Deterministic syntax checks outrank the live route in three narrow
      // cases: a question can never be a mutation (a small model reads
      // hypotheticals as edits and deletes real content), a vague deictic
      // reference must not be upgraded to a mutation (keyword grounding would
      // then guess a target from accidental token hits), and "replace X with
      // Y" is always an edit_text — routing it as add_text would insert the
      // replacement instead of swapping the span, and the blast-radius critic
      // never sees the destructive intent.
      if (route && !route.directive && route.action === 'file_mutation') {
        const localSyntax = routeCommand(command)
        if (
          localSyntax.action === 'conversational_only' &&
          /Interrogative turn/i.test(localSyntax.reason)
        ) {
          route = {
            ...localSyntax,
            reason: `${localSyntax.reason} Live d1 route said ${route.action}; the imperative-syntax check overrode it.`,
          }
          runtime.route = 'fallback'
          } else if (
            localSyntax.action === 'ambiguous_request' &&
            isVagueMutation(command)
          ) {
            // The live route upgraded "delete that part" to a mutation; the
            // deterministic vague-reference guardrail diverts it to the same
            // clarification flow the local router produces. Provenance is
            // relabeled like the interrogative override — the effective
            // decision is the deterministic one — and the reason records
            // what the live route originally said.
            route = {
              ...localSyntax,
              reason: `${localSyntax.reason} Live d1 route said ${route.action}; the vague-reference guardrail diverted it to clarification.`,
            }
            runtime.route = 'fallback'
          } else if (
            route.primaryTool &&
            route.primaryTool !== 'edit_text' &&
            /\b(?:replace|swap|substitute)\b/i.test(command) &&
            /\bwith\b/i.test(command)
          ) {
            const pinned = pFloor(
              route.allowedTools.find((tool) => tool.name === 'edit_text')?.p,
              0.3,
            )
            route = {
              ...route,
              primaryTool: 'edit_text',
              allowedTools: [
                { name: 'edit_text', p: pinned },
                ...route.allowedTools.filter((tool) => tool.name !== 'edit_text'),
              ],
              reason: `${route.reason} · "replace … with …" pinned to edit_text by the syntax check.`,
            }
          } else if (
            route.primaryTool &&
            route.primaryTool !== 'extract_visual_to_note' &&
            /\b(?:extract|pull|grab|copy|transcribe|ocr|import|capture|bring|take)\b/i.test(command) &&
            /\b(?:slide|whiteboard|screen|camera|image|photo|frame|chart|diagram|sticky)\b/i.test(command)
          ) {
            const pinned = pFloor(
              route.allowedTools.find((tool) => tool.name === 'extract_visual_to_note')?.p,
              0.3,
            )
            route = {
              ...route,
              primaryTool: 'extract_visual_to_note',
              allowedTools: [
                { name: 'extract_visual_to_note', p: pinned },
                ...route.allowedTools.filter((tool) => tool.name !== 'extract_visual_to_note'),
              ],
              reason: `${route.reason} · extraction verb plus a named visual source pinned to extract_visual_to_note.`,
            }
          }
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
        const memory = conversationTurns(messagesRef.current, CHAT_MEMORY_TURNS)
        // Stage the assistant bubble now; streamed tokens fill it live.
        const streamId = addMessage({
          role: 'assistant',
          kind: 'result',
          text: '',
          streaming: true,
          runId: traceLocal.id,
        })
        const controller = new AbortController()
        chatAbortRef.current = controller
        let reply = ''
        let aborted = false
        let lastFlush = 0
        const flush = () => {
          const now = performance.now()
          if (now - lastFlush < 48) return
          lastFlush = now
          patchMessage(streamId, { text: sanitizeOmniText(reply) })
        }
        // Live path: LFM3-Omni-2B over /v1/chat/completions, streamed. The frame
        // is attached only for visual-relevant turns — small talk stays fast.
        if (endpointUp(healthRef.current, 'omni')) {
          try {
            const wantsVisual =
              /\b(see|look|slide|screen|camera|show|image|frame|describe|chart|table|formula|sticky|whiteboard|visual|read)\b/i.test(
                command,
              )
            const frame = wantsVisual ? await resolveSceneFrame('full') : null
            if (frame) traceLocal.frameSource = frame.source
            const completion = await chatCompleteStream(
              'omni',
              buildChatMessages(
                command,
                noteAtStart,
                lastRun,
                memory,
                frame,
              ),
              {
                temperature: 0.3,
                maxTokens: 500,
                signal: controller.signal,
                onToken: (delta) => {
                  reply += delta
                  flush()
                },
              },
            )
            reply = completion.text
            runtime.chat = 'live'
            traceLocal.timings.chat = completion.ms
            traceLocal.outputTokens = completion.usage.outputTokens || estimateTokens(reply)
            if (completion.usage.promptTokens) {
              traceLocal.promptTokens = completion.usage.promptTokens
              liveUsage.omni = completion.usage.promptTokens
            }
          } catch {
            aborted = controller.signal.aborted
          } finally {
            if (chatAbortRef.current === controller) chatAbortRef.current = null
          }
        }

        // Omni is chat-only: strip tool-call artifacts it improvises before
        // the reply is accepted, displayed or spoken. An all-artifact reply
        // falls through to the deterministic template below.
        reply = sanitizeOmniText(reply)

        if (aborted && !reply.trim()) {
          // Cut before the first token: never leave an empty bubble behind.
          setMessages((previous) => previous.filter((message) => message.id !== streamId))
          finish('conversational')
          return
        }
        if (!reply.trim()) {
          // Fallback: deterministic local templates. The scene's true source
          // decides what may be described: only the synthetic slide's content
          // is known by construction; a live frame is never described by a
          // template (audit TD-18).
          reply = conversationalReply(command, noteAtStart, lastRun, currentSceneSource())
          traceLocal.outputTokens = estimateTokens(reply)
          setContextUsage((previous) => ({
            ...previous,
            omni: clamp(
              previous.omni + 120 + Math.round(estimateTokens(command) / 2),
              1200,
              30000,
            ),
          }))
        } else if (aborted && runtime.chat !== 'live') {
          // Partial tokens did arrive from the model before the abort.
          runtime.chat = 'live'
          traceLocal.outputTokens = estimateTokens(reply)
        }
        patchMessage(streamId, { text: reply, streaming: false })
        publish()
        if (!aborted) speakReply(reply)
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
      // Deterministic pre-pass: literal pre-empts (exact quote, line numbers,
      // ordinals) plus the fallback candidate search. A vague reference then
      // goes to d1-Omni's typed span question in resolveGroundingSpan below.
      const groundStarted = performance.now()
      let plan = buildPlan(command, effectiveRoute, noteAtStart)
      // d1's tool pick can fail to ground (e.g. add_text chosen for an update
      // command). Retry the runner-up tools from d1's own distribution before
      // falling back to a clarification, and record the repair in the reason.
      if (plan.problem && effectiveRoute.primaryTool) {
        const failedTool = effectiveRoute.primaryTool
        // Adoption-gate the alternatives: an unreported runner-up (d1 chose
        // without a distribution) is still a candidate; a measured score must
        // clear the prune. Unreported sorts as adopted, mirroring the ranking.
        const alternatives = effectiveRoute.allowedTools
          .filter((tool) => pAdopted(tool.p, 0.2) && tool.name !== failedTool)
          .sort((a, b) => (b.p ?? 1) - (a.p ?? 1))
        for (const alternative of alternatives) {
          const retryPlan = buildPlan(
            command,
            { ...effectiveRoute, primaryTool: alternative.name },
            noteAtStart,
          )
          if (!retryPlan.problem) {
            // The critic's `tool_match` demands adoption-gated membership, so
            // the switched tool must be visible in allowedTools — otherwise
            // the retry wins grounding and is then guaranteed rejected. A
            // measured score below the repair floor is replaced by the flat
            // heuristic floor (the reason records the repair); an unreported
            // score stays unreported.
            const mergedTools = effectiveRoute.allowedTools.some(
              (tool) => tool.name === alternative.name,
            )
              ? effectiveRoute.allowedTools.map((tool) =>
                  tool.name === alternative.name ? { ...tool, p: pFloor(tool.p, 0.5) } : tool,
                )
              : [
                  ...effectiveRoute.allowedTools,
                  { name: alternative.name, p: pFloor(alternative.p, 0.5) },
                ]
            effectiveRoute = {
              ...effectiveRoute,
              primaryTool: alternative.name,
              allowedTools: mergedTools,
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
      // d1-Omni typed span grounding: structural candidates are enumerated
      // from the note and d1 answers one choice question over them. A d1
      // outage or sub-threshold choice keeps the deterministic search; the
      // trace records which path ran.
      const grounding = await resolveGroundingSpan(
        command,
        noteAtStart,
        plan,
        effectiveRoute.primaryTool,
        { live: endpointUp(healthRef.current, 'd1omni') },
      )
      if (grounding.span) {
        plan = { ...plan, span: grounding.span }
      }
      if (grounding.planPatch) {
        plan = { ...plan, ...grounding.planPatch }
      }
      if (grounding.promptTokens) {
        liveUsage.d1 = grounding.promptTokens
      }
      traceLocal.grounding = {
        source: grounding.source,
        p: grounding.p,
        chosenLine: grounding.span?.startLine,
        candidateCount: grounding.offered,
        detail: grounding.detail,
      }
      traceLocal.route = effectiveRoute
      traceLocal.timings.ground = Number((performance.now() - groundStarted).toFixed(1))
      if (traceLocal.timings.ground < 180) await sleep(180 - traceLocal.timings.ground)

      const acknowledgement = ackFor(effectiveRoute.primaryTool)
      addMessage({
        role: 'assistant',
        kind: 'ack',
        text: acknowledgement,
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
      // Worker selection: LFM3-1.7B (256K ctx) decodes every text mutation; a
      // down 1.7B falls back to the deterministic template, so a run never
      // fails on worker availability alone. Visual extraction never calls a
      // model: the supervisor's deterministic extractor already carries the
      // Markdown, so there the template call IS the call.
      const wantsText = effectiveRoute.primaryTool !== 'extract_visual_to_note'
      const textWorkerUp = wantsText && endpointUp(healthRef.current, 'text')
      const delegation = {
        runId: traceLocal.id,
        tool: effectiveRoute.primaryTool,
        status: 'generating' as const,
        modelLabel: wantsText ? '1.7B' : 'local',
        thought: wantsText
          ? 'The 1.7B worker is decoding the grounded hints into one XML tool call.'
          : (templateCall?.thought ??
            'The supervisor is building the deterministic extraction call.'),
      }
      const delegationId = addMessage({
        role: 'tool',
        text: '',
        delegation,
      })

      setStage('generating')
      setStageStates({ A: 'done', B: 'done', C: 'idle' })
      setFlowModel('worker')

      // Live path: the 1.7B emits the XML tool call over /v1/chat/completions.
      // Fallback: the deterministic template.
      let call: WorkerCall | null = null
      if (textWorkerUp) {
        try {
          const messages = buildWorkerMessages(command, effectiveRoute, plan, noteAtStart)
          // The 1.7B reasons at length before closing its  thinking block
          // (~2K tokens on the windowed prompt); a 900-token budget truncated
          // it mid-think, so give it room and one spare attempt before falling
          // back to the deterministic template.
          const attempts: ChatOptions[] = [
            { temperature: 0.3, maxTokens: 3000 },
            { temperature: 0.4, maxTokens: 3000 },
          ]
          for (const options of attempts) {
            const completion = await chatComplete('text', messages, options)
            const rawText = completion.text
            const xmlInput = /<think>/.test(rawText)
              ? rawText
              : completion.reasoning
                ? `<think>${completion.reasoning}</think>\n${rawText}`
                : rawText
            const parsed = parseToolCallXml(xmlInput)
            // Mismatched-but-sensible calls were dropped on both attempts: the
            // 1.7B often picks the better tool (edit_text for an update routed
            // as add_text). Accept any allowed tool with real routing support;
            // the critic still gates execution afterwards.
            const routed =
              parsed !== null &&
              (parsed.name === effectiveRoute.primaryTool ||
                effectiveRoute.allowedTools.some(
                  (tool) => tool.name === parsed.name && pAdopted(tool.p, 0.25),
                ))
            const required = parsed
              ? TOOL_BY_NAME[parsed.name].params
                  .filter((param) => param.required)
                  .map((param) => param.name)
              : []
            const complete =
              parsed !== null &&
              routed &&
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
                // Exactly what this attempt put on the wire — the trace's
                // sampler chips read it back instead of hardcoding values.
                // The fallbacks mirror chatComplete's own request defaults.
                {
                  temperature: options.temperature ?? 0.1,
                  maxTokens: options.maxTokens ?? 700,
                },
              )
              runtime.worker = 'live'
              traceLocal.timings.generate = completion.ms
              traceLocal.outputTokens = call.rawTokens
              if (completion.usage.promptTokens) {
                traceLocal.promptTokens = completion.usage.promptTokens
                liveUsage.worker = completion.usage.promptTokens
              }
              patchMessage(delegationId, {
                delegation: {
                  ...delegation,
                  thought: call.thought,
                  modelLabel: '1.7B',
                },
              })
              break
            }
            }
        } catch {
          call = null
        }
      }
      if (!call) {
        if (!templateCall) throw new Error('Worker could not build a call from supervisor hints.')
        call = templateCall
        traceLocal.timings.generate = 0.2
        // The deterministic template executed: relabel the delegation card so
        // it never claims a 1.7B decode that did not happen (audit TD-13).
        if (wantsText) {
          patchMessage(delegationId, {
            delegation: {
              ...delegation,
              modelLabel: 'local',
              thought: `${templateCall.thought} The 1.7B worker was ${
                textWorkerUp ? 'asked but returned no usable call' : 'unavailable'
              } — this call was built locally instead.`,
            },
          })
        }
        if (traceLocal.timings.generate < 240) await sleep(240)
      }
      // The supervisor owns the target. A live worker can narrow a multi-line
      // grounded span to the one line it finds salient ("that section about API
      // keys" → the API-key bullet), which the critic would reject even though
      // d1 already settled the span. Emit the supervisor's exact call instead;
      // the critic still gates its blast radius and anchors.
      if (
        templateCall &&
        call !== templateCall &&
        call.name === templateCall.name &&
        call.name !== 'add_text' &&
        call.name !== 'extract_visual_to_note' &&
        `${call.params.start_line}:${call.params.end_line}` !==
          `${templateCall.params.start_line}:${templateCall.params.end_line}`
      ) {
        patchMessage(delegationId, {
          delegation: {
            ...delegation,
            modelLabel: 'supervisor',
            thought: `The worker proposed lines ${call.params.start_line}–${call.params.end_line}; the grounded span was ${templateCall.params.start_line}–${templateCall.params.end_line}, so the supervisor's exact call replaced it.`,
          },
        })
        call = templateCall
        runtime.worker = 'fallback'
        traceLocal.timings.generate = 0.2
        traceLocal.outputTokens = call.rawTokens
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
            // A 2B model's cautious 0.4–0.5 scores were vetoing calls whose
            // local hard gates (anchor exactness, blast radius, bounds) all
            // passed. This block only runs when they did; the semantic pass is
            // an overlay, so only a confidently bad score rejects.
            const localPassed = critic.verdict === 'verified'
            const accepted = localPassed && answer.noul >= 0.35
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

      // Any rejection layer — critic verdict or engine-level refusal — lands
      // in rejectedTraces so the drawer/export shows every stopped call, not
      // only the ones the critic caught (audit TD-44).
      const recordRejectedTrace = (reason: string | undefined, pCorrect: Probability) => {
        setRejectedTraces((previous) => [
          ...previous,
          {
            at: Date.now(),
            command,
            route: {
              tool: effectiveRoute.primaryTool,
              provenance:
                traceLocal.runtime?.route === 'live'
                  ? 'd1-Omni · /v1/systemone'
                  : 'local heuristics',
            },
            spanCandidates: grounding.candidates.map((candidate) => ({
              startLine: candidate.startLine,
              endLine: candidate.endLine,
              excerpt: candidate.excerpt,
            })),
            grounding: {
              source: grounding.source,
              chosenLine: grounding.span?.startLine,
              p: grounding.p,
            },
            workerXml: call.xml,
            critic: { verdict: 'rejected', reason, pCorrect },
          },
        ])
      }

      if (critic.verdict === 'rejected') {
        setStageStates({ A: 'done', B: 'done', C: 'failed' })
        patchMessage(delegationId, {
          delegation: { ...delegation, status: 'rejected' },
        })
        const rejection =
          'I paused before execution. The supervisor rejected the proposed tool call, so the note was not touched. Open the trace to see which check failed.'
        traceLocal.status = 'rejected'
        recordRejectedTrace(critic.feedback, critic.pCorrect)
        addMessage({
          role: 'assistant',
          kind: 'error',
          text: rejection,
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
      const execution = executeTool(
        noteAtStart,
        { ...call, name: parsed.name, params: parsed.params },
        plan.span,
      )
      traceLocal.timings.execute = Number((performance.now() - execStarted).toFixed(1))
      traceLocal.execution = execution
      publish()

      if (!execution.ok) {
        setStageStates({ A: 'done', B: 'done', C: 'done' })
        patchMessage(delegationId, {
          delegation: { ...delegation, status: 'rejected', confidence: critic.pCorrect },
        })
        traceLocal.status = 'failed'
        recordRejectedTrace(execution.message, critic.pCorrect)
        addMessage({
          role: 'assistant',
          kind: 'error',
          text: `I stopped before writing. ${execution.message} The note was not changed.`,
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




