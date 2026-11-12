import type { RunMode } from './lib/runmode'

export type ToolName =
  | 'add_text'
  | 'edit_text'
  | 'remove_text'

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
  | 'generating'
  | 'verifying'
  | 'executing'
  | 'complete'

export type StageId = 'A' | 'B' | 'C'

export type StageState = 'idle' | 'running' | 'done' | 'skipped' | 'failed'

export interface ToolParam {
  name: string
  type: string
  required: boolean
  description: string
}

export interface ToolDefinition {
  name: ToolName
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

/**
 * Who produced a rejected-call record: the worker itself (its call failed the
 * gates or the safety check) or the user at pending-edit adjudication. The
 * rejected-traces log records it so each refusal's provenance is auditable.
 */
export type GroundingSource = 'worker-self' | 'pending-adjudication'

/** Sampler settings actually sent with a live worker decode. */
export interface WorkerSampler {
  temperature: number
  /** null = no max_tokens sent: the decode ran uncapped. */
  maxTokens: number | null
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
  grounding: { source: GroundingSource; chosenLine?: number; p?: Probability }
  workerXml: string
  critic: { verdict: 'rejected'; reason?: string; pCorrect: Probability }
  /** The Audio directive that produced the rejected call (P5+; absent on legacy records — §9.2). */
  directive?: Directive
  /** The d1 verdict that routed the call here (P5+; absent on legacy records — §9.2). */
  d1?: PendingEdit['d1']
}

export interface TraceTimings {
  route: number
  generate: number
  critic: number
  execute: number
  total: number
  /** Conversational reply generation (streamed chat), measured end-to-end. */
  chat?: number
}

/**
 * One message of a recorded exchange, as the turn inspector shows it: a
 * serializable projection of the bridge's ChatMessage (tool_calls flattened
 * to name + raw arguments).
 */
export interface ExchangeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant message only: the calls that completion made. */
  toolCalls?: Array<{ name: string; arguments: string }>
  /** Tool-role message only: the id of the call this result answers. */
  toolCallId?: string
}

/**
 * One full request/response pair against a model server, recorded per turn
 * no matter the outcome — conversational replies, tool-call decodes,
 * retries and failures all land here so any turn is inspectable after the
 * fact, not just turns that produced a verified tool call.
 */
export interface TurnExchange {
  id: string
  /** Which model slot served the exchange: the chat front door or the worker. */
  role: 'chat' | 'worker'
  /** Label within the turn: 'primary', 'repair retry', 'worker attempt 2', … */
  label: string
  /** Model name that answered (e.g. 'LFM3-Audio-2B'). */
  model: string
  /** URL the request hit. */
  url: string
  at: number
  ms: number
  /** False when the request threw, was aborted, or its reply was unusable. */
  ok: boolean
  /** Why the exchange failed (transport error, abort, or parse rejection). */
  error?: string
  request: {
    messages: ExchangeMessage[]
    stream: boolean
    temperature: number
    /** null = no max_tokens sent (uncapped decode). */
    maxTokens: number | null
    /** Names of the tool definitions attached, when any. */
    tools?: string[]
  }
  /** Absent when the request never returned (transport failure / abort). */
  response?: {
    text: string
    reasoning: string
    toolCalls: Array<{ name: string; arguments: string }>
    promptTokens: number
    outputTokens: number
    finishReason: string | null
  }
}

export interface Trace {
  id: string
  at: number
  command: string
  source: 'voice' | 'text' | 'demo'
  /** Run mode that served this turn (worker-chat modes only; absent on Omni-first/legacy traces). */
  runMode?: RunMode
  /** Omni's typed delegation directive (P2+; absent on legacy/supervisor-first traces). */
  directive?: Directive
  call?: WorkerCall
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
  /**
   * Every model request/response pair this turn made, in order —
   * conversational and failed turns included. Absent on legacy persisted
   * traces; the inspector treats absent as empty.
   */
  exchanges?: TurnExchange[]
  /**
   * Why the turn stopped or was held before execution (hard-gate refusal,
   * blast-radius hold, engine refusal, outcome check, d1 verdict). Absent
   * when the turn ran to completion or was purely conversational.
   */
  hold?: TurnHold
}

/**
 * Why a turn stopped or was held before execution — recorded so the trace
 * drawer can always answer "what happened to my edit", even when the run
 * produced no worker call or ended pending. `d1` holds are also covered by
 * `d1Check`; the drawer renders this block for every other kind.
 */
export interface TurnHold {
  kind:
    | 'hard-gate'
    | 'blast-radius'
    | 'blast-collapse'
    | 'no-decision-model'
    | 'engine'
    | 'outcome'
    | 'd1'
  reason: string
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
  /** Who authored an assistant bubble: the chat model's name for model text, 'harness' for pipeline templates. Absent only on legacy persisted messages. */
  author?: string
  kind?: 'greeting' | 'result' | 'error' | 'notice'
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
  id: 'omni' | 'audio' | 'd1' | 'worker'
  /** Which flow-rail slot this row lights up ('omni' = the interface row). */
  flow: 'omni' | 'd1' | 'worker'
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
  id: 'omni' | 'd1omni' | 'text' | 'audio'
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
 */
export interface DirectiveTarget {
  /** What was asked for, in Omni's resolved words ("top of the note, before the Q3 heading"). */
  description: string
  /** The heading the target sits under, when Omni resolved one; null otherwise. */
  heading: string | null
}

export interface Directive {
  /** Coarse operation class; the worker still chooses the concrete tool. */
  task: 'create' | 'insert' | 'edit' | 'remove'
  /** The brief: everything the user meant, references resolved, no chat. */
  instruction: string
  /** Optional resolved target description; the worker grounds the exact span. */
  target?: DirectiveTarget
  /** Exact user-dictated text to insert as-is, when the user dictated it; null otherwise. */
  verbatim?: string | null
  /** Formatting/scope constraints ("markdown", "keep the existing Q3 content intact"). */
  constraints?: string[]
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
  /**
   * Insertion neighbourhood for `add_text`
   * pendings (battery case 33): those calls carry no line range and the
   * hard gates have no anchor for them, so this is their staleness anchor —
   * the authoring note's lines either side of the insertion point
   * (`startLine` is the diff's, i.e. where the inserted content begins in
   * the executed note; `precedingLine`/`followingLine` are the authoring
   * note's lines at that boundary, null at a document edge). Absent on
   * span-tool pendings (their anchor gate is exact already) and on
   * pendings persisted before this field existed.
   */
  insertion?: {
    startLine: number
    precedingLine: string | null
    followingLine: string | null
  }
  /**
   * The d1 result that routed this call here. Normally disapproved or
   * unavailable; 'approved' appears only for a §8 blast-radius hold
   * (issue #58), where d1 approved but the edit's class — a section-scale
   * collapse — never executes silently.
   */
  d1: {
    verdict: 'approved' | 'disapproved' | 'unavailable'
    noul: number | null
    destructiveSafety: 'safe' | 'unintended_data_loss' | null
    reason?: string
  }
  /** pending: awaiting adjudication; applied/discarded: resolved by the user; stale: gates failed on ✓ (drifted anchor). */
  status: 'pending' | 'applied' | 'discarded' | 'stale'
  /**
   * Set when the only gate failure was the blast-radius cap: approval
   * executes the removal with the cap waived (the user overrode a
   * destructiveness limit, never a correctness gate). Absent on every
   * other pending.
   */
  overrideBlastRadius?: true
}
