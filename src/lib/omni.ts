/**
 * Omni turn client (design.md §2/§4, P2): every turn reaches Omni first.
 *
 * One call to {@link runOmniTurn} is one user turn against LFM3-Omni-2B. It
 * builds the conversation (frame per the E2 config, note per design.md §6),
 * sends it with the two native tool definitions (E1/D4's winning mechanism —
 * native tool calls on the local llama.cpp build, `--jinja`), streams the
 * visible reply, and parses the outcome:
 *
 *   answer    no tool call — the (sanitized) completion text
 *   delegate  a delegate_edit call whose arguments validate (directive.ts)
 *   action    a harness_action call (undo | redo)
 *   clarify   a delegate attempt failed validation twice → a follow-up Omni
 *             call WITHOUT tools asks the user one model-authored question
 *
 * Rules this module is bound to (spike evidence in docs/spikes/):
 *
 * - Abort (barge-in): the signal is checked before every stage transition and
 *   during streaming; on abort runOmniTurn returns null — no outcome, no
 *   partial directive. The caller must also drop any provisional bubble it
 *   fed through onText.
 * - Endpoint failures THROW {@link OmniTurnError} (never fabricate, never
 *   null): Omni down means the turn fails honestly with the endpoint state
 *   for the UI (design.md §11).
 * - A server-side tool-parse HTTP 500 (llama.cpp refused the generated call —
 *   the client never sees the raw text; E2's finding) is its OWN error class:
 *   ONE bare retry (identical messages, nothing appended), then
 *   OmniTurnError('server-tool-parse').
 * - History discipline (E1 run-3): the assistant channel carries ONLY
 *   model-authored text and tool_calls; the tool result ("Executed" /
 *   "Execution failed") travels in the tool role; harness strings never enter
 *   the assistant channel (the 2B few-shot-copies them).
 * - Visible text: streamed/delivered only for answer/clarify. Nothing is
 *   forwarded during the tools call itself — a completion may carry text AND
 *   a tool call, and the binding rule is that a mixed completion's text is
 *   never shown; only post-hoc classification can guarantee that (answer text
 *   is delivered to onText in one completion-time shot). The clarify
 *   follow-up carries no tools, so its deltas are streamed live. Delegation
 *   is silent.
 */

import type { ChatMessage, ChatResult, ChatStreamOptions, ToolDef } from './bridge'
import { chatCompleteStream } from './bridge'
import type { Directive, OmniTurnResult } from '../types'
import { buildDirectiveRepairMessage, validateDirective } from './directive'
import { NOTE_PATH, NOTE_TITLE } from '../data/note'
import { truncate } from './utils'

// --- sampling/serving (E2/D4, binding) -----------------------------------------

/** E2: outcome accuracy identical across 0/0.3/0.7; 0.3 chosen for robustness. */
export const OMNI_TEMPERATURE = 0.3
/** E2: one measured truncation at 500 (a create-directive cut mid-JSON) → 700. */
export const OMNI_MAX_TOKENS = 700
/** E2: keep the shipped 3,600-char note cap (cap/full was an honest no-op). */
export const NOTE_CONTEXT_CAP_CHARS = 3_600
/** How many prior turns the conversation model sees (shipped chat discipline). */
export const HISTORY_TURNS = 6
/** Per-entry truncation for replayed history commands/replies (shipped value). */
export const HISTORY_TURN_CHARS = 600

// --- injected bridge access ----------------------------------------------------

/**
 * The one bridge capability runOmniTurn needs, as an injectable function so
 * tests (and any future transport) never touch the network. Defaults to the
 * live streamed chat call against the Omni endpoint.
 */
export type OmniChatFn = (
  messages: ChatMessage[],
  options: ChatStreamOptions,
) => Promise<ChatResult>

const defaultChat: OmniChatFn = (messages, options) => chatCompleteStream('omni', messages, options)

// --- typed errors (design.md §11: honest failure, endpoint state for the UI) ---

export interface OmniEndpointState {
  id: 'omni'
  name: string
  port: number
  url: string
}

export const OMNI_ENDPOINT: OmniEndpointState = {
  id: 'omni',
  name: 'LFM3-Omni-2B',
  port: 8083,
  url: 'http://127.0.0.1:8083',
}

export type OmniTurnErrorKind =
  /** Bridge/endpoint failure (unreachable, timeout, non-500 HTTP error, unusable payload). */
  | 'endpoint'
  /**
   * llama.cpp refused to parse the generated tool call server-side (HTTP 500
   * on a tools request — E2's finding: the raw text never reaches the
   * client). One bare retry happened; the server refused again.
   */
  | 'server-tool-parse'
  /** The completion had no tool call and no usable visible text after sanitizing. */
  | 'empty-reply'

export class OmniTurnError extends Error {
  readonly kind: OmniTurnErrorKind
  readonly endpoint?: OmniEndpointState
  readonly status?: number
  readonly detail?: string

  constructor(
    kind: OmniTurnErrorKind,
    message: string,
    endpoint?: OmniEndpointState,
    status?: number,
    detail?: string,
  ) {
    super(message)
    this.name = 'OmniTurnError'
    this.kind = kind
    this.endpoint = endpoint
    this.status = status
    this.detail = detail
  }
}

// --- tool definitions (native calls, E1/D4) -------------------------------------

export const DELEGATE_EDIT_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'delegate_edit',
    description:
      'Delegate one note change to the edit worker as a typed directive. Call this exactly once, ' +
      'only when the user wants the note changed AND the request is fully resolved. Never for chat, ' +
      'hypotheticals, or undo/redo.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          enum: ['create', 'insert', 'edit', 'remove', 'extract'],
          description:
            'Operation class: edit = change existing content in place; insert = add new content ' +
            'without replacing anything; remove = delete existing content; create = author a new ' +
            'document or section skeleton; extract = pull content from the attached frame.',
        },
        instruction: {
          type: 'string',
          description:
            'Brief for the worker: EVERYTHING the user specified about the content (sections named, ' +
            'values given, exact dictated wording, tone asked for), references like "the same for Q4" ' +
            'resolved from the conversation. A brief, not the content itself.',
        },
        target: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Where the change belongs.' },
            heading: { type: ['string', 'null'], description: 'Section heading, or null.' },
          },
          description: 'Optional: where in the note the change belongs. The worker grounds the exact span.',
        },
        verbatim: {
          type: ['string', 'null'],
          description: 'Exact user-dictated text, only when the user dictated exact words; otherwise null.',
        },
        constraints: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Optional requirements, e.g. ["markdown", "keep the existing content intact"].',
        },
        frame_relevant: {
          type: 'boolean',
          description: 'True only when the task depends on the attached visual frame.',
        },
      },
      required: ['task', 'instruction'],
    },
  },
}

export const HARNESS_ACTION_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'harness_action',
    description:
      'Run a harness action on the note history. Only for undo/redo of the last change — never a ' +
      'worker task, never a delegation.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['undo', 'redo'],
          description: 'undo = revert to the previous snapshot; redo = re-apply the next snapshot.',
        },
      },
      required: ['action'],
    },
  },
}

export const OMNI_TOOLS: ToolDef[] = [DELEGATE_EDIT_TOOL, HARNESS_ACTION_TOOL]

// --- prompt contract (design.md §5/§10, E1 failure classes, D6) ------------------

/**
 * The answer / clarify / delegate contract, replacing the shipped "you have
 * no tools, hand edits to the pipeline" prompt. Targets E1's three measured
 * failure classes directly: (a) task-tag selection — per-task one-line
 * definitions; (b) ambiguity → delegate-a-guess — the ASK move; (c)
 * brief-not-content drift on create — the instruction rule.
 */
export const OMNI_SYSTEM_PROMPT = [
  'You are Omni — the conversational interface of a local multimodal note workspace. The user talks to you; each turn shows you the current note state and, when an image is attached, the live visual frame (what the user calls "the slide", "the chart" or "the screen").',
  'On every user turn, do exactly one of three things:',
  '1. ANSWER — reply in plain conversational text: greetings, questions, chat, memory, hypotheticals ("what happens if …"), anything that does not require changing the note. You never author note content yourself, not even as a draft in chat: note content is written only by the edit worker, and the only way to reach it is the delegate_edit call.',
  '2. ASK — if the user wants the note changed but their request is too ambiguous to act on responsibly (an unresolved "this", "it", "that number", or an unspecified outcome like "make it better"), reply with ONE short clarifying question. Never delegate a guess: a wrong edit is worse than a question.',
  '3. DELEGATE — when the user wants the note changed and you can fully resolve what they mean, call delegate_edit exactly once with the directive as its arguments. The directive is a brief for a worker that never sees this conversation:',
  '   - task — the operation class, picked by what happens to the note, not by the user\'s verb:',
  '       edit    — change existing content in place. Updating a value, a table row, a heading, or rewording a passage is edit, not insert.',
  '       insert  — add new content without replacing or removing anything that already exists.',
  '       remove  — delete existing content. Removing a row or a bullet is remove, not edit.',
  '       create  — author a new document or section skeleton from scratch.',
  '       extract — pull content from the attached frame into the note.',
  '   - instruction — a brief, not the content: pack in EVERYTHING the user specified about the content (sections named, values given, exact dictated wording, tone asked for) and resolve references like "the same for Q4" or "that bullet" from the conversation yourself. Describe the README\'s sections; never write the README. The only content that travels in the directive is verbatim.',
  '   - target — optional object {"description": where the change belongs, "heading": section heading or null}.',
  '   - verbatim — exact dictated text only when the user dictated exact words to appear in the note; otherwise null.',
  '   - constraints — optional array of requirements, e.g. ["markdown", "keep the existing content intact"].',
  '   - frame_relevant — true only when the task depends on the attached visual frame.',
  'Undo and redo are not tasks: when the user asks to undo or redo the last change, call harness_action with {"action": "undo"} or {"action": "redo"} and nothing else.',
  'Never narrate the machinery: no mention of pipelines, workers, tools, calls, stages or schemas in what you say or show — the user asks, you answer or ask, and when they ask for a change their note simply changes.',
  'Style: brief and natural, one or two sentences unless more is genuinely needed. Reference the note or the attached frame only when the turn is actually about them; when asked what you can see, describe the attached frame itself.',
].join('\n')

/** The user-role instruction for the repair-failure clarify follow-up (no tools). */
export const CLARIFY_FOLLOWUP_INSTRUCTION =
  'You could not produce a usable edit instruction for that request. Do not call any tool and do ' +
  'not attempt the edit yourself. Reply with exactly ONE short question to the user that would let ' +
  'you carry out their request confidently — nothing else.'

// --- turn input (the contract the pipeline wires against) ------------------------

export type OmniTurnSource = 'voice' | 'text' | 'demo'

export interface OmniFrameAttachment {
  source: 'live-camera' | 'live-screen' | 'synthetic-slide'
  dataUrl: string
}

/**
 * A past delegation as it persists in history (E1 run-3 policy): the
 * assistant made the call, the harness answered in the tool role.
 * `arguments` is the verbatim serialized arguments string — never re-authored
 * here (the caller serializes the recorded directive / action).
 */
export interface OmniDelegationRecord {
  tool: 'delegate_edit' | 'harness_action'
  arguments: string
  result: 'Executed' | 'Execution failed'
}

/** One prior turn, distilled: the command, and the model's own output for it. */
export interface OmniHistoryTurn {
  command: string
  /** Model-authored visible reply (answer turns). Never a harness template. */
  reply?: string
  /** The delegation that turn made, when it made one (then reply is absent). */
  delegation?: OmniDelegationRecord
}

export interface OmniLastRun {
  command: string
  status: string
  message?: string
}

export interface OmniTurnInput {
  /** The user's command for this turn, verbatim. */
  command: string
  /** Provenance of the command; recorded by the caller, not branched on here. */
  source: OmniTurnSource
  /** Prior turns, oldest first (the last HISTORY_TURNS are used). */
  history: OmniHistoryTurn[]
  /** Current note text; §6 policy below decides how much of it is sent. */
  note: string
  /** The resolved frame to attach, or null when the turn has none. */
  frame: OmniFrameAttachment | null
  /** Last completed edit run, for continuity; null when none yet. */
  lastRun: OmniLastRun | null
  /** Barge-in signal: checked before every stage and during streaming. */
  signal?: AbortSignal
  /**
   * Visible-text callback. answer: one completion-time delivery of the full
   * sanitized text. clarify: live raw deltas from the (tool-less) follow-up
   * stream. delegate/action: never called. Streamed deltas are provisional;
   * result.text is authoritative.
   */
  onText?: (delta: string) => void
  /** Injectable bridge chat call (tests); defaults to the live Omni endpoint. */
  chat?: OmniChatFn
}

// --- §6 context policy ------------------------------------------------------------

const FRAME_DESCRIPTIONS: Record<OmniFrameAttachment['source'] | 'none', string> = {
  'live-camera': 'Attached is the current live frame from the device camera.',
  'live-screen': 'Attached is the current live frame from the screen share.',
  'synthetic-slide':
    'Attached is the synthetic operating-review slide frame (no live capture is attached).',
  none: 'No frame is attached for this turn.',
}

/**
 * "About the note" test (shipped NOTE_QUESTION lineage) extended with a
 * mutation hint: a command whose point is to change the note is about the
 * note. Context assembly only — no outcome depends on this regex; it picks
 * full-note vs outline per design.md §6, nothing else.
 */
const NOTE_QUESTION =
  /\b(note|notes|document|doc|section|table|heading|paragraph|bullet|line|lines|read it|what does it say|content|says|text)\b/i
const MUTATION_HINT =
  /\b(update|add|remove|delete|insert|change|rename|edit|create|write|append|move|copy|duplicate|fix|revise|rewrite|extract|pull)\b/i

export function turnIsAboutNote(command: string): boolean {
  return NOTE_QUESTION.test(command) || MUTATION_HINT.test(command)
}

/** Title plus the first H2 headings as a one-line outline, no full dump. */
export function noteOutline(note: string): string {
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
 * The note context for one turn (§6): full text when the turn is about the
 * note (capped at 3,600 chars, the cut recorded in the text), outline
 * otherwise.
 */
export function noteContextFor(command: string, note: string): string {
  if (!turnIsAboutNote(command)) {
    return `Current note (${NOTE_PATH}) outline: ${noteOutline(note)}`
  }
  if (note.length <= NOTE_CONTEXT_CAP_CHARS) {
    return `Current note (${NOTE_PATH}):\n${note}`
  }
  const shown = note.slice(0, NOTE_CONTEXT_CAP_CHARS)
  return (
    `Current note (${NOTE_PATH}):\n${shown}\n` +
    `…[note truncated: showing ${NOTE_CONTEXT_CAP_CHARS} of ${note.length} characters]`
  )
}

// --- history assembly (E1 run-3 discipline) ----------------------------------------

/**
 * Build the full message array for a turn: system prompt, replayed history
 * (assistant channel = model text and/or tool_calls only; delegation results
 * in the tool role), and the user turn (frame description, note context, last
 * run, command; the frame attached as image_url exactly the way bridge.ts
 * attaches frames).
 */
export function buildOmniMessages(input: OmniTurnInput): ChatMessage[] {
  const history = input.history.slice(-HISTORY_TURNS).flatMap((turn, index): ChatMessage[] => {
    const user: ChatMessage = { role: 'user', content: truncate(turn.command, HISTORY_TURN_CHARS) }
    if (!turn.delegation) {
      if (turn.reply && turn.reply.trim()) {
        return [user, { role: 'assistant', content: truncate(turn.reply, HISTORY_TURN_CHARS) }]
      }
      return [user]
    }
    const id = `omni-call-${index}`
    const assistant: ChatMessage = {
      role: 'assistant',
      content: turn.reply && turn.reply.trim() ? truncate(turn.reply, HISTORY_TURN_CHARS) : '',
      tool_calls: [
        { id, type: 'function', function: { name: turn.delegation.tool, arguments: turn.delegation.arguments } },
      ],
    }
    const result: ChatMessage = { role: 'tool', tool_call_id: id, content: turn.delegation.result }
    return [user, assistant, result]
  })

  const textParts = [
    input.frame ? FRAME_DESCRIPTIONS[input.frame.source] : FRAME_DESCRIPTIONS.none,
    noteContextFor(input.command, input.note),
    input.lastRun
      ? `Last completed run: "${input.lastRun.command}" → ${input.lastRun.status}${
          input.lastRun.message ? ` (${input.lastRun.message})` : ''
        }`
      : 'No edits have been committed yet this session.',
    `User: ${input.command}`,
  ].join('\n\n')

  const content: ChatMessage['content'] = input.frame
    ? [{ type: 'text', text: textParts }, { type: 'image_url', image_url: { url: input.frame.dataUrl } }]
    : textParts

  return [{ role: 'system', content: OMNI_SYSTEM_PROMPT }, ...history, { role: 'user', content }]
}

// --- sanitizer (design.md §10 hygiene, extended to native-tool markers) ------------

const TOOL_BLOCK_MARKERS = /tool_call|function=|delegate_edit|harness_action|ACTION\s+(?:undo|redo)/i

const TOOL_JSON_MARKERS = /"task"\s*:|"instruction"\s*:|"delegate_edit"|"harness_action"/

/** Find the brace-balanced end of a JSON object starting at `open`; -1 if unbalanced. */
function balancedJsonEnd(text: string, open: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Remove bare JSON objects carrying directive/tool vocabulary (a leaked or
 * truncated tool call rendered as text). Brace-balanced and string-aware, so
 * nested objects are consumed whole (E2's mid-JSON truncation shape) and
 * ordinary braces in prose survive.
 */
function stripToolJson(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor)
    if (open < 0) {
      out += text.slice(cursor)
      break
    }
    const end = balancedJsonEnd(text, open)
    const candidate = end > open ? text.slice(open, end + 1) : text.slice(open)
    if (TOOL_JSON_MARKERS.test(candidate)) {
      out += text.slice(cursor, open)
      cursor = end > open ? end + 1 : text.length
    } else {
      out += text.slice(cursor, open + 1)
      cursor = open + 1
    }
  }
  return out
}

/**
 * Visible/TTS text hygiene (§10): nothing the user sees or hears may carry
 * the delegation mechanism. Extends the shipped discipline (pipeline.ts's
 * sanitizeOmniText lineage) to the native-tool markers: tool-call JSON,
 * `<function=…>` fragments, `<<<DIRECTIVE`-style blocks (including the
 * invented `<<<README TEMPLATE` drift shapes from E1's delimited run), and
 * ACTION signal lines. Normal prose passes untouched.
 */
export function sanitizeOmniText(text: string): string {
  let clean = text
  // Fenced blocks that are tool vocabulary (whole and unterminated-truncation forms).
  clean = clean.replace(/```[^\n]*\n[\s\S]*?```/g, (block) =>
    TOOL_BLOCK_MARKERS.test(block) || TOOL_JSON_MARKERS.test(block) ? ' ' : block,
  )
  clean = clean.replace(/```[^\n]*\n[\s\S]*$/g, (block) =>
    TOOL_BLOCK_MARKERS.test(block) || TOOL_JSON_MARKERS.test(block) ? ' ' : block,
  )
  // Native/tool-call tag fragments.
  clean = clean.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ')
  clean = clean.replace(/<tool_call>[\s\S]*$/i, ' ')
  clean = clean.replace(/<function=[\s\S]*?<\/function>/gi, ' ')
  clean = clean.replace(/<function=[^>]*>/gi, ' ')
  // <<<DIRECTIVE-style delimited blocks, closed or running to the end.
  clean = clean.replace(/<<<[\s\S]*?(?:>>>|$)/g, '')
  // ACTION signal lines (the textual undo/redo marker this design replaces),
  // whole line, so consecutive signal lines all go.
  clean = clean
    .split('\n')
    .filter((line) => !/^[ \t]*ACTION[ :]+(undo|redo)\b/i.test(line))
    .join('\n')
  // Bare tool-call JSON.
  clean = stripToolJson(clean)
  return clean.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// --- outcome parsing ----------------------------------------------------------------

type ToolEvaluation =
  | { kind: 'delegate'; directive: Directive }
  | { kind: 'action'; action: 'undo' | 'redo' }
  | { kind: 'invalid'; error: string }
  | { kind: 'none' }

/** The first tool call of a completion decides; extra calls are ignored (E1 never observed multiples). */
function evaluateToolCall(call: ChatResult['toolCalls'][number] | null): ToolEvaluation {
  if (!call) return { kind: 'none' }
  if (call.function.name === 'delegate_edit') {
    let parsed: unknown
    try {
      parsed = JSON.parse(call.function.arguments)
    } catch (error) {
      return {
        kind: 'invalid',
        error: `delegate_edit arguments are not valid JSON (${
          error instanceof Error ? error.message : 'parse error'
        })`,
      }
    }
    const validation = validateDirective(parsed)
    if (validation.valid) return { kind: 'delegate', directive: validation.directive }
    return { kind: 'invalid', error: validation.error }
  }
  if (call.function.name === 'harness_action') {
    let parsed: unknown
    try {
      parsed = JSON.parse(call.function.arguments)
    } catch (error) {
      return {
        kind: 'invalid',
        error: `harness_action arguments are not valid JSON (${
          error instanceof Error ? error.message : 'parse error'
        })`,
      }
    }
    if (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
      'action' in parsed &&
      ((parsed as { action: unknown }).action === 'undo' ||
        (parsed as { action: unknown }).action === 'redo')
    ) {
      return { kind: 'action', action: (parsed as { action: 'undo' | 'redo' }).action }
    }
    return { kind: 'invalid', error: 'harness_action arguments must be JSON like {"action": "undo"} or {"action": "redo"}' }
  }
  return {
    kind: 'invalid',
    error: `unknown tool "${call.function.name}" — the available tools are delegate_edit and harness_action`,
  }
}

/** Repair user-message for non-directive tool failures (directive has its own exported builder). */
function buildToolRepairMessage(error: string): string {
  return `That tool call was rejected: ${error} Call the corrected tool (delegate_edit or harness_action) again now, with valid arguments.`
}

/** Internal control-flow sentinel: the turn was aborted; unwind to `null`. */
class TurnAborted extends Error {
  constructor() {
    super('Omni turn aborted mid-stream')
  }
}

// --- the turn --------------------------------------------------------------------------

/**
 * Run one Omni turn (the front door). Resolves per the outcome contract
 * above; null on abort. Throws OmniTurnError on endpoint failure, on a
 * twice-refused server-side tool parse (HTTP 500), and on a reply that is
 * entirely unusable.
 */
export async function runOmniTurn(input: OmniTurnInput): Promise<OmniTurnResult | null> {
  try {
    return await runTurn(input)
  } catch (error) {
    if (error instanceof TurnAborted) return null
    throw error
  }
}

async function runTurn(input: OmniTurnInput): Promise<OmniTurnResult> {
  const chat = input.chat ?? defaultChat
  const started = performance.now()
  let promptTokens = 0
  let outputTokens = 0

  const aborted = () => input.signal?.aborted === true
  const elapsed = () => Number((performance.now() - started).toFixed(1))
  const result = (outcome: OmniTurnResult['outcome'], fields: Partial<OmniTurnResult> = {}): OmniTurnResult => ({
    outcome,
    ms: elapsed(),
    ...(promptTokens ? { promptTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
    ...fields,
  })

  /**
   * onToken wrapper attached to every request: the abort check that runs
   * DURING streaming (§barge-in). Deltas are forwarded to onText only on the
   * tool-less clarify stream (streamDeltas) — the tools call never forwards.
   */
  const streamingOnToken = (forward: boolean) => (delta: string) => {
    if (aborted()) throw new TurnAborted()
    if (forward) input.onText?.(delta)
  }

  function toEndpointError(error: unknown): OmniTurnError {
    const detail = error instanceof Error ? error.message : String(error)
    return new OmniTurnError(
      'endpoint',
      `Omni turn failed: ${detail}`,
      OMNI_ENDPOINT,
      undefined,
      detail,
    )
  }

  /**
   * One request against Omni. Tools requests get E2's bare-retry policy for
   * server-side tool-parse 500s (the client never sees the raw call — nothing
   * can be appended); tool-less requests surface endpoint errors directly.
   */
  async function request(
    messages: ChatMessage[],
    options: { tools?: ToolDef[]; streamDeltas?: boolean },
  ): Promise<ChatResult> {
    const requestOptions: ChatStreamOptions = {
      temperature: OMNI_TEMPERATURE,
      maxTokens: OMNI_MAX_TOKENS,
      signal: input.signal,
      ...(options.tools ? { tools: options.tools } : {}),
      onToken: streamingOnToken(options.streamDeltas === true),
    }
    const attempt = () => chat(messages, requestOptions)
    try {
      const completion = await attempt()
      promptTokens += completion.usage.promptTokens
      outputTokens += completion.usage.outputTokens
      return completion
    } catch (error) {
      if (aborted() || error instanceof TurnAborted) throw new TurnAborted()
      if (options.tools && error instanceof Error && /^HTTP 500/.test(error.message)) {
        // One bare retry: identical messages, nothing appended (E2's blind spot).
        try {
          const completion = await attempt()
          promptTokens += completion.usage.promptTokens
          outputTokens += completion.usage.outputTokens
          return completion
        } catch (retryError) {
          if (aborted() || retryError instanceof TurnAborted) throw new TurnAborted()
          const detail = retryError instanceof Error ? retryError.message : String(retryError)
          if (retryError instanceof Error && /^HTTP 500/.test(retryError.message)) {
            throw new OmniTurnError(
              'server-tool-parse',
              'Omni server refused the generated tool call twice (HTTP 500 tool-parse)',
              OMNI_ENDPOINT,
              500,
              detail,
            )
          }
          throw toEndpointError(retryError)
        }
      }
      throw toEndpointError(error)
    }
  }

  // -- stage 0: entry ------------------------------------------------------------
  if (aborted()) throw new TurnAborted()

  // -- stage 1: the primary tools call --------------------------------------------
  const messages = buildOmniMessages(input)
  const primary = await request(messages, { tools: OMNI_TOOLS })
  if (aborted()) throw new TurnAborted()

  const firstCall = primary.toolCalls[0] ?? null
  const firstEvaluation = evaluateToolCall(firstCall)
  if (firstEvaluation.kind === 'none') {
    // No tool call → answer. Nothing was forwarded during the call (a mixed
    // text+tool completion's text is never shown); deliver it now, sanitized.
    const text = sanitizeOmniText(primary.text)
    if (!text) {
      throw new OmniTurnError(
        'empty-reply',
        'Omni reply contained only unusable tool markup (no tool call, no visible text)',
        OMNI_ENDPOINT,
      )
    }
    input.onText?.(text)
    return result('answer', { text })
  }
  if (firstEvaluation.kind === 'delegate') return result('delegate', { directive: firstEvaluation.directive })
  if (firstEvaluation.kind === 'action') return result('action', { action: firstEvaluation.action })

  // -- stage 2: the ONE repair retry (schema error appended; design.md §5) ----------
  const isDirectiveTool = firstCall?.function.name === 'delegate_edit'
  const repairUserMessage = isDirectiveTool
    ? buildDirectiveRepairMessage(firstEvaluation.error)
    : buildToolRepairMessage(firstEvaluation.error)
  const firstCallId = firstCall?.id || 'omni-call-repair'
  const repairMessages: ChatMessage[] = [
    ...messages,
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: firstCallId, type: 'function', function: { name: firstCall!.function.name, arguments: firstCall!.function.arguments } },
      ],
    },
    { role: 'tool', tool_call_id: firstCallId, content: `Execution failed: ${firstEvaluation.error}` },
    { role: 'user', content: repairUserMessage },
  ]
  if (aborted()) throw new TurnAborted()
  const repaired = await request(repairMessages, { tools: OMNI_TOOLS })
  if (aborted()) throw new TurnAborted()

  const secondCall = repaired.toolCalls[0] ?? null
  const secondEvaluation = evaluateToolCall(secondCall)
  if (secondEvaluation.kind === 'delegate') {
    return result('delegate', { directive: secondEvaluation.directive })
  }
  if (secondEvaluation.kind === 'action') {
    return result('action', { action: secondEvaluation.action })
  }
  // Still invalid, no corrected call, or a text-only repair response: not an
  // outcome — the clarify follow-up re-asks cleanly (repair failure is a
  // clarify, never a guess).

  // -- stage 3: the clarify follow-up (no tools, model-authored question) -----------
  const lastFailed = secondCall ?? firstCall!
  const lastError =
    secondEvaluation.kind === 'invalid'
      ? secondEvaluation.error
      : firstEvaluation.kind === 'invalid'
        ? firstEvaluation.error
        : 'the corrected tool call did not arrive'
  const lastCallId = lastFailed.id || 'omni-call-clarify'
  const clarifyMessages: ChatMessage[] = [
    ...messages,
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: lastCallId, type: 'function', function: { name: lastFailed.function.name, arguments: lastFailed.function.arguments } },
      ],
    },
    { role: 'tool', tool_call_id: lastCallId, content: `Execution failed: ${lastError}` },
    { role: 'user', content: CLARIFY_FOLLOWUP_INSTRUCTION },
  ]
  if (aborted()) throw new TurnAborted()
  const clarify = await request(clarifyMessages, { streamDeltas: true })
  if (aborted()) throw new TurnAborted()
  const question = sanitizeOmniText(clarify.text)
  if (!question) {
    throw new OmniTurnError(
      'empty-reply',
      'Omni clarify follow-up returned no usable text',
      OMNI_ENDPOINT,
    )
  }
  return result('clarify', { text: question })
}
