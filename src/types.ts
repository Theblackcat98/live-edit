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

export interface TraceTimings {
  route: number
  ground: number
  generate: number
  critic: number
  execute: number
  total: number
}

export interface Trace {
  id: string
  at: number
  command: string
  source: 'voice' | 'text' | 'demo'
  route?: RouteDecision
  span?: SpanTarget
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
  frameSource?: 'synthetic-slide' | 'none'
}

export interface MessageAction {
  label: string
  command: string
}

export interface DelegationInfo {
  runId: string
  tool: ToolName
  status: 'generating' | 'verified' | 'executed' | 'rejected'
  confidence?: number
  thought?: string
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
  /** Worker XML: LFM3-VL-2B /v1/chat/completions, or the template emitter. */
  worker: RuntimeSource
  /** Critic verdict: d1-Omni semantic pass + local checks, or local checks only. */
  critic: RuntimeSource
  /** Conversational reply: Omni /v1/chat/completions, or canned templates. */
  chat: RuntimeSource
}

export interface EndpointHealth {
  id: 'omni' | 'vl' | 'd1omni'
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
