export type ToolName =
  | 'add_text'
  | 'edit_text'
  | 'remove_text'
  | 'extract_visual_to_note'

export type ActionClass =
  | 'conversational_only'
  | 'file_mutation'
  | 'ambiguous_request'

export type RunStatus =
  | 'running'
  | 'clarify'
  | 'verified'
  | 'rejected'
  | 'conversational'
  | 'failed'

export type PipelineStage =
  | 'idle'
  | 'routing'
  | 'grounding'
  | 'generating'
  | 'verifying'
  | 'executing'
  | 'complete'

export type StageId = 'A' | 'B' | 'C'

export type StageState = 'idle' | 'running' | 'done' | 'skipped' | 'failed'

export type SourceId = 'camera' | 'screen'

export type VideoMode = 'synthetic' | 'device' | 'screen'

export interface ToolParam {
  name: string
  type: string
  required: boolean
  description: string
}

export interface ToolDefinition {
  name: ToolName
  description: string
  params: ToolParam[]
}

export interface ToolScore {
  name: ToolName
  p: number
}

export interface RouteDecision {
  action: ActionClass
  actionConfidence: number
  allowedTools: ToolScore[]
  primaryTool?: ToolName
  reason: string
  directive?: 'undo' | 'redo'
}

export interface SpanTarget {
  startLine: number
  endLine: number
  excerpt: string
  confidence: number
  reason: string
  phrase?: string
}

/**
 * Which path resolved the target span: d1-Omni's typed span question over
 * /v1/systemone (`d1-span`), or the deterministic supervisor search
 * (`fallback-keyword` — keyword/quote/ordinal/line reference, or the literal
 * pre-empts that never need a model call). The trace records it so a run's
 * provenance is auditable.
 */
export type GroundingSource = 'd1-span' | 'fallback-keyword'

export interface GroundingRecord {
  source: GroundingSource
  /** d1-Omni probability for the chosen candidate (live path only). */
  p?: number
  /** 1-based first line of the resolved span. */
  chosenLine?: number
  /** Structural candidates the grounding question offered. */
  candidateCount?: number
  /** Why the deterministic fallback ran, when it did. */
  detail?: string
}

export type SceneRegionId =
  | 'full'
  | 'header'
  | 'table'
  | 'q3-row'
  | 'formula'
  | 'chart'
  | 'sticky'

export interface BBoxTarget {
  region: SceneRegionId
  label: string
  confidence: number
  source: 'camera' | 'screen'
}

export interface CriticCheck {
  label: string
  pass: boolean
  detail?: string
}

export interface CriticResult {
  verdict: 'verified' | 'rejected'
  pCorrect: number
  pSafe: number
  checks: CriticCheck[]
  feedback?: string
}

export interface WorkerCall {
  name: ToolName
  params: Record<string, string>
  thought: string
  xml: string
  rawTokens: number
  promptHints: string[]
  toolSchemasInjected: number
  noteView: string
}

export interface ExecutionDiff {
  startLine: number
  before: string[]
  after: string[]
  added: number
  removed: number
}

export interface ExecutionResult {
  ok: boolean
  message: string
  tool: ToolName | 'undo' | 'redo' | 'none'
  note: string
  diff?: ExecutionDiff
  durationMs: number
  snapshotId?: string
}

export interface RejectedTraceRecord {
  at: number
  command: string
  route: { tool?: ToolName; provenance: string }
  spanCandidates: Array<{ startLine: number; endLine: number; excerpt: string }>
  grounding: { source: GroundingSource; chosenLine?: number; p?: number }
  workerXml: string
  critic: { verdict: 'rejected'; reason?: string; pCorrect: number }
}

export interface TraceTimings {
  route: number
  ground: number
  generate: number
  critic: number
  execute: number
  total: number
  /** Conversational reply generation (streamed chat), measured end-to-end. */
  chat?: number
}

/**
 * Which pixels the models actually received for a run.
 * `none` means no frame was attached at all — never claim a source by default.
 */
export type FrameSource = 'live-camera' | 'live-screen' | 'synthetic-slide' | 'none'

/** A live camera/screen snapshot registered by the visual panel. */
export interface LiveFrame {
  dataUrl: string
  source: SourceId
  at: number
}

/** A resolved frame handed to the models, with its true provenance. */
export interface ResolvedFrame {
  dataUrl: string
  source: FrameSource
}

export interface Trace {
  id: string
  at: number
  command: string
  source: 'voice' | 'text' | 'demo'
  route?: RouteDecision
  span?: SpanTarget
  /** How the span was resolved (d1 typed question vs deterministic search). */
  grounding?: GroundingRecord
  bbox?: BBoxTarget
  call?: WorkerCall
  critic?: CriticResult
  execution?: ExecutionResult
  timings: TraceTimings
  status: RunStatus
  outputTokens: number
  promptTokens: number
  noteTokensAtStart: number
  workerNoteView: string
  runtime?: TraceRuntime
  frameSource?: FrameSource
}

export interface MessageAction {
  label: string
  command: string
}

export type SuggestionIcon = 'table' | 'remove' | 'scan' | 'eye'

export interface Suggestion {
  label: string
  command: string
  icon: SuggestionIcon
  /** 'submit' sends the command; 'draft' fills the composer for the user to finish. */
  mode: 'submit' | 'draft'
}

export interface DelegationInfo {
  runId: string
  tool: ToolName
  status: 'generating' | 'verified' | 'executed' | 'rejected'
  confidence?: number
  thought?: string
  /** Short model label for the card title; defaults to the active worker (1.7B). */
  modelLabel?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  at: number
  kind?: 'greeting' | 'ack' | 'result' | 'clarify' | 'error' | 'notice'
  source?: 'voice' | 'text' | 'demo'
  durationSec?: number
  runId?: string
  actions?: MessageAction[]
  animate?: boolean
  delegation?: DelegationInfo
  /** Assistant text is still arriving token by token from the model stream. */
  streaming?: boolean
}

export interface Snapshot {
  id: string
  at: number
  label: string
  note: string
  tool: string
  automatic: boolean
}

export interface ModelInfo {
  id: 'omni' | 'd1' | 'worker'
  role: string
  shortName: string
  name: string
  params: string
  contextK: number
  quant: string
  memGB: number
  color: 'green' | 'accent' | 'orange'
  description: string
}

export type RuntimeSource = 'live' | 'fallback'

export type D1Answer =
  | { type: 'choice'; choice: string; probabilities?: Record<string, number> }
  | { type: 'score'; score: number }
  | { type: 'noul'; noul: number }

export interface TraceRuntime {
  /** Voice capture → Omni /v1/audio/transcriptions, or typed input. */
  asr?: RuntimeSource
  /** Route decision: d1-Omni /v1/systemone, or local heuristics. */
  route: RuntimeSource
  /** Worker XML: LFM3-1.7B /v1/chat/completions, or the template emitter. */
  worker: RuntimeSource
  /** Critic verdict: d1-Omni semantic pass + local checks, or local checks only. */
  critic: RuntimeSource
  /** Conversational reply: Omni /v1/chat/completions, or canned templates. */
  chat: RuntimeSource
}

export interface EndpointHealth {
  id: 'omni' | 'd1omni' | 'text'
  name: string
  role: string
  port: number
  url: string
  up: boolean
  latencyMs?: number
  models?: string[]
  error?: string
}

export interface RuntimeHealth {
  at: number
  endpoints: EndpointHealth[]
}

export interface ContextUsage {
  omni: number
  d1: number
  worker: number
}

export interface Toast {
  id: number
  title: string
  detail?: string
  tone?: 'neutral' | 'success' | 'error'
}

export interface ToolEventState {
  status: 'generating' | 'verified' | 'executed' | 'rejected'
  tool: ToolName
  confidence?: number
  runId: string
}

export interface PendingClarification {
  originalCommand: string
  tool: ToolName
  runId: string
  options: MessageAction[]
}

export interface WorkspaceState {
  note: string
  title: string
  path: string
  history: Snapshot[]
  historyIndex: number
  messages: Message[]
  trace: Trace | null
  runs: Trace[]
  stage: PipelineStage
  stageStates: Record<StageId, StageState>
  busy: boolean
  span: SpanTarget | null
  bbox: BBoxTarget | null
  diff: ExecutionDiff | null
  contextUsage: ContextUsage
  sourceMode: boolean
  speakerOn: boolean
  micOn: boolean
  activityTab: 'supervisor' | 'context'
}
