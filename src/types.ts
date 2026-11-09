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
  /**
   * The run produced a pending edit (design.md §9) that awaits user
   * adjudication; the turn is paused, not over. Phase-1 contract only —
   * nothing produces this status yet.
   */
  | 'pending'

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

/**
 * Probability a model (or the deterministic router) assigned to a choice.
 * `null` means unreported: the decision exists, but nobody measured a
 * probability for it. An unreported score satisfies adoption-level gates
 * (the choice stands) but never a decisive one (it cannot overturn another
 * path's result). Flat numbers from the local router are heuristic values —
 * stable across runs, labelled by the surrounding fallback provenance.
 */
export type Probability = number | null

export interface ToolScore {
  name: ToolName
  /** d1's measured probability, the local router's flat heuristic, or null (unreported). */
  p: Probability
}

export interface RouteDecision {
  action: ActionClass
  /** d1's measured confidence, the local router's flat heuristic, or null (unreported). */
  actionConfidence: Probability
  allowedTools: ToolScore[]
  primaryTool?: ToolName
  reason: string
  directive?: 'undo' | 'redo'
}

export interface SpanTarget {
  startLine: number
  endLine: number
  excerpt: string
  /** Heuristic (deterministic search) or d1-measured; null when d1 chose without reporting one. */
  confidence: Probability
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
export type GroundingSource = 'd1-span' | 'fallback-keyword' | 'worker-self' | 'pending-adjudication'

export interface GroundingRecord {
  source: GroundingSource
  /** d1-Omni probability for the chosen candidate (live path only); null when unreported. */
  p?: Probability
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
  /**
   * d1's measured semantic score (live overlay only). The local critic never
   * invents one: null means unreported, and the verdict tracks the local
   * checks alone — numbers never gate a local decision.
   */
  pCorrect: Probability
  /** Same semantics as pCorrect; no local path measures a safety probability. */
  pSafe: Probability
  checks: CriticCheck[]
  feedback?: string
}

/** Sampler settings actually sent with a live worker decode. */
export interface WorkerSampler {
  temperature: number
  maxTokens: number
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
  /** Present only when a live decode produced this call; absent for template calls. */
  sampler?: WorkerSampler
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
  grounding: { source: GroundingSource; chosenLine?: number; p?: Probability }
  workerXml: string
  critic: { verdict: 'rejected'; reason?: string; pCorrect: Probability }
  /** The Omni directive that produced the rejected call (P5+; absent on legacy records — §9.2). */
  directive?: Directive
  /** The d1 verdict that routed the call here (P5+; absent on legacy records — §9.2). */
  d1?: PendingEdit['d1']
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
  /** Omni's typed delegation directive (P2+; absent on legacy/supervisor-first traces). */
  directive?: Directive
  route?: RouteDecision
  span?: SpanTarget
  /** How the span was resolved (d1 typed question vs deterministic search). */
  grounding?: GroundingRecord
  bbox?: BBoxTarget
  call?: WorkerCall
  critic?: CriticResult
  /** The d1 safety-check result (P4+; Omni-first traces only — legacy traces carry `critic`). */
  d1Check?: D1CheckResult
  /** Omni tool-call repair diagnostics (Omni-first traces only; mirrors OmniTurnResult.repair). */
  omniRepair?: { error: string; rawArguments: string }
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
  /**
   * Phase-1 additions: `checking` (hard gates / d1 check in flight) and
   * `pending` (the edit awaits user adjudication, design.md §9). Nothing
   * produces them yet — the old pipeline still emits only the original four.
   */
  status: 'generating' | 'checking' | 'pending' | 'verified' | 'executed' | 'rejected'
  /** d1's measured critic score; null/undefined hides the P chip (never invented). */
  confidence?: Probability
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
  /** Worker XML: LFM3-1.7B /v1/chat/completions, the template emitter, or the dictation exception (harness-built call, design.md §11). */
  worker: RuntimeSource | 'dictation'
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

// --- Phase-1 pipeline contracts (architecture-refactor.md §5.1) ----------------
// Additive only: these types describe the Omni-first pipeline (design.md) so
// later phases are type-led. Nothing produces or consumes them yet; the legacy
// types above stay until their phase deletes them.

/**
 * The Omni → worker delegation contract (design.md §5). Omni resolves the
 * user's references ("the same for Q4", "that bullet") *inside* the directive,
 * so the worker can act on it almost standalone.
 *
 * Rules from design.md §5:
 * - `instruction` is a **brief, not the content** — except that Omni must pack
 *   into it everything the user specified about the content (sections named,
 *   values given, tone asked for).
 * - `verbatim` is the one case where content legitimately travels inside the
 *   directive: the user dictated exact words, and the worker inserts them as-is.
 * - `target` is optional; the worker grounds the exact span itself.
 * - A directive is per-turn and ephemeral; it is recorded in the trace.
 *
 * Note: the `frame_extract` field (decision D2) is deliberately absent — it
 * lands with Phase 3 and is mirrored into design.md §5 then.
 */
export interface DirectiveTarget {
  /** What was asked for, in Omni's resolved words ("top of the note, before the Q3 heading"). */
  description: string
  /** The heading the target sits under, when Omni resolved one; null otherwise. */
  heading: string | null
}

export interface Directive {
  /** Coarse operation class; the worker still chooses the concrete tool. */
  task: 'create' | 'insert' | 'edit' | 'remove' | 'extract'
  /** The brief: everything the user meant, references resolved, no chat. */
  instruction: string
  /** Optional resolved target description; the worker grounds the exact span. */
  target?: DirectiveTarget
  /** Exact user-dictated text to insert as-is, when the user dictated it; null otherwise. */
  verbatim?: string | null
  /** Formatting/scope constraints ("markdown", "keep the existing Q3 content intact"). */
  constraints?: string[]
  /** Whether the worker's task depends on the current video frame. */
  frame_relevant?: boolean
}

/**
 * What a single Omni turn resolved to (design.md §2/§4). Exactly one outcome
 * per turn: Omni answers, asks for clarification, silently delegates to the
 * worker, or maps the user's words to a harness action (undo/redo/apply a
 * pending edit).
 */
export type OmniOutcome = 'answer' | 'clarify' | 'delegate' | 'action'

/**
 * The result of one omni.ts turn (design.md §4). `null` from runOmniTurn means
 * the turn was aborted (barge-in) — a partial directive must never execute, so
 * an abort yields no outcome at all. Endpoint failures do NOT return null:
 * they throw a typed error the pipeline turns into an honest failure message
 * with the endpoint state shown (design.md §11).
 */
export interface OmniTurnResult {
  outcome: OmniOutcome
  /** Sanitized visible reply text for answer/clarify; absent for delegate/action. */
  text?: string
  /** The validated directive, present iff outcome = delegate. */
  directive?: Directive
  /** The harness action, present iff outcome = action. */
  action?: 'undo' | 'redo'
  /**
   * Diagnostics when a tool call failed validation and the repair retry ran:
   * the validation error and the raw emitted arguments (truncated). Present
   * on clarify-after-repair-failure and on delegate/action outcomes the
   * repair rescued — the evidence the next diagnosis works from, never UI copy.
   */
  repair?: { error: string; rawArguments: string }
  ms: number
  promptTokens?: number
  outputTokens?: number
}

/**
 * One completed edit turn distilled for the worker context packet
 * (design.md §6): outcomes, not transcript. Assistant prose is excluded by
 * construction — this record is built from the directive and the recorded
 * diff, never from chat.
 */
export interface EditTurnRecord {
  /** The user's command for that turn, verbatim. */
  command: string
  /** The directive that drove the turn, truncated (summaries are the directives themselves). */
  directiveSummary: string
  /** One-line summary of the diff the turn produced. */
  diffSummary: string
}

/**
 * The worker's context packet (design.md §6): the last 3 completed edit turns
 * (most recent last) plus the packet's prompt-token estimate, so the trace can
 * record the real budget spent. The full line-numbered note travels with the
 * prompt itself, not inside this packet.
 */
export interface ContextPacket {
  /** Up to 3 most recent completed edit turns, oldest first (most recent last). */
  editTurns: EditTurnRecord[]
  /** Estimated prompt-token cost of the packet (assembly-time estimate, recorded honestly). */
  promptTokens: number
}

/**
 * Result of the d1 safety check (design.md §7). `unavailable` is a first-class
 * verdict: d1 down, malformed answer, or an otherwise unusable response is
 * never silently mapped to approval (or to rejection) — it means the user
 * decides instead.
 */
export interface D1CheckResult {
  /** approved: noul ≥ threshold and destructive_safety = safe; disapproved otherwise; unavailable per above. */
  verdict: 'approved' | 'disapproved' | 'unavailable'
  /** d1's measured `does_call_match_directive` score; null when unreported/unavailable. */
  noul: number | null
  /** d1's `destructive_safety` choice; null when unreported/unavailable. */
  destructiveSafety: 'safe' | 'unintended_data_loss' | null
  /** Which typed question failed the verdict (shown to the user on a pending card). */
  failingQuestion?: string
  /** Human-readable reason (bridge error detail, threshold explanation). */
  reason?: string
  /** Wall-clock duration of the check, in ms. */
  ms?: number
}

/**
 * A first-class pending edit awaiting user adjudication (design.md §9). A
 * pending edit modifies nothing — not the note, the snapshot stack, or the
 * undo chain — until the user approves it and the hard gates re-run.
 */
export interface PendingEdit {
  /** Stable id for the card, the queue (FIFO) and voice adjudication references. */
  id: string
  /** When the proposal was created (epoch ms). */
  createdAt: number
  /** The Omni directive that produced this proposal. */
  directive: Directive
  /** The parsed worker tool call under adjudication. */
  call: WorkerCall
  /** The diff rendered against the note version the call was authored against. */
  diff: ExecutionDiff
  /** Hash of the note the call was authored against; staleness compares against the current note. */
  noteHash: string
  /** The d1 result that routed this call here. Only disapproved/unavailable can appear. */
  d1: {
    verdict: 'disapproved' | 'unavailable'
    noul: number | null
    destructiveSafety: 'safe' | 'unintended_data_loss' | null
    reason?: string
  }
  /** pending: awaiting adjudication; applied/discarded: resolved by the user; stale: gates failed on ✓ (drifted anchor). */
  status: 'pending' | 'applied' | 'discarded' | 'stale'
}
