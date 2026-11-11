/**
 * Worker-chat turn client for run modes `worker-d1` and `lowram`.
 *
 * In these modes LFM3-1.7B (:8080) is the chat model itself: it answers in
 * prose, asks one clarifying question, or authors exactly one XML tool call.
 * This module mirrors omni.ts's shape — an injectable streamed chat function
 * (tests never touch the network), a message builder, and one outcome
 * parser — so the pipeline can wire it like any other model turn.
 *
 * The 1.7B does not reliably produce native OpenAI tool calls on this
 * llama.cpp build, so the proven repo XML contract (xml.ts) is used and the
 * call is parsed out of the reply text. The exchange is streamed: the visible
 * channel is everything OUTSIDE <think> blocks, and only that reaches the
 * user's bubble.
 */

import type { ChatMessage, ChatResult, ChatStreamOptions } from './bridge'
import { chatCompleteStream } from './bridge'
import type { ToolName } from '../types'
import { NOTE_PATH } from '../data/note'
import { TOOL_DEFS } from '../data/tools'
import { parseToolCallXml, type ParsedToolCall } from './xml'
import { HISTORY_TURN_CHARS, HISTORY_TURNS, sanitizeOmniText } from './omni'
import { truncate } from './utils'

// --- sampling/serving ----------------------------------------------------------

/** Same robustness rationale as Audio's 0.3 (E2: accuracy flat across 0/0.3/0.7). */
export const WORKER_CHAT_TEMPERATURE = 0.3
/**
 * The 1.7B reasons at length in <think> before answering or calling; the
 * packet-worker measurement (E4: 3,000 truncated deliberators mid-call) is
 * why the chat turn gets the same generous cap, not the 700-token Omni
 * budget.
 */
export const WORKER_CHAT_MAX_TOKENS = 3_000

/** Sampler actually sent, recorded on the trace's WorkerCall. */
export const WORKER_CHAT_SAMPLER = {
  temperature: WORKER_CHAT_TEMPERATURE,
  maxTokens: WORKER_CHAT_MAX_TOKENS,
} as const

// --- injected bridge access ----------------------------------------------------

/**
 * The one bridge capability a worker-chat turn needs, injectable so tests
 * never touch the network. Defaults to the live streamed chat call against
 * LFM3-1.7B.
 */
export type WorkerChatFn = (
  messages: ChatMessage[],
  options: ChatStreamOptions,
) => Promise<ChatResult>

const defaultChat: WorkerChatFn = (messages, options) =>
  chatCompleteStream('text', messages, options)

// --- typed errors ---------------------------------------------------------------

export type WorkerChatErrorKind = 'endpoint' | 'empty-reply'

export class WorkerChatError extends Error {
  readonly kind: WorkerChatErrorKind

  constructor(kind: WorkerChatErrorKind, message: string) {
    super(message)
    this.name = 'WorkerChatError'
    this.kind = kind
  }
}

// --- tool catalog (adapted from worker.ts's packet catalog) ---------------------

/**
 * TOOL_DEFS descriptions assume a supervisor supplied the anchor. In this
 * mode there is no supervisor — the chat turn grounds itself — so the
 * parameter text is rewritten once, here, and nowhere else.
 */
const PARAM_DESCRIPTION_FIXES: Record<string, string> = {
  'Target note path.': `the target note: ${NOTE_PATH}`,
  'Line number or exact heading supplied by the supervisor.':
    'line number or exact heading text to anchor the insertion (required for after_line and under_heading)',
  'Where the content is inserted.':
    "where the content is inserted — under_heading inserts at the END of that heading's section (after its existing content); after_line inserts immediately after line N",
}

const TOOL_USE_WHEN: Record<ToolName, string> = {
  add_text:
    'adding NEW lines — a new bullet, paragraph, section, or whole document — without replacing or deleting existing lines',
  edit_text: 'changing text that already exists — fixing a value, rewording a row, renaming a heading',
  remove_text: 'deleting existing lines — a bullet, a table row, or a whole section',
}

/**
 * The three-tool catalog in the repo XML contract, one parameter table per
 * tool. Deliberately no filled example calls: the packet prompt's v2 lesson
 * (worker.ts) is that a small model reads complete example calls as its own
 * prior turns and re-deliberates them.
 */
export function renderWorkerChatToolCatalog(notePath: string = NOTE_PATH): string {
  return TOOL_DEFS.map((tool) => {
    const params = tool.params
      .map((param) => {
        const description =
          PARAM_DESCRIPTION_FIXES[param.description] ??
          param.description.replace('Target note path.', `the target note: ${notePath}`)
        return `  ${param.name} (${param.type}${param.required ? ', required' : ', optional'}): ${description}`
      })
      .join('\n')
    return [
      `<schema function=${tool.name}>`,
      `Use when: ${TOOL_USE_WHEN[tool.name]}.`,
      'Parameters (exactly these — a parameter from another tool is rejected):',
      params,
      '</schema>',
    ].join('\n')
  }).join('\n\n')
}

// --- prompt contract ------------------------------------------------------------

/**
 * The answer-or-call contract. Two legal reply shapes only: plain prose
 * (answer / one clarifying question) or exactly one XML tool call. The note
 * excerpt is authoritative — the 1.7B must never invent note content, and an
 * ambiguous target is a question, not a guess. This mode is text-only.
 */
export const WORKER_CHAT_SYSTEM_PROMPT = [
  'You are the assistant in a local note workspace. The user talks to you, and when they ask for a change you make it yourself with exactly one tool call.',
  'HOW TO REPLY — exactly one of two shapes:',
  '1. Plain prose: an answer, an opinion, a greeting, or ONE short clarifying question. No XML, no JSON, no code fences, and no talk of tools, calls, or this process.',
  '2. Exactly one tool call in the repo XML contract:',
  '<tool_call>',
  '<function=TOOL_NAME>',
  '<parameter=NAME>',
  'value',
  '</parameter>',
  '</function>',
  '</tool_call>',
  'Nothing may follow </tool_call>. If you reason first, keep it to at most three short lines inside <think></think> before the call.',
  'Never mix prose and a tool call in one reply, never emit several calls, and never invent tools or parameters.',
  'RULES:',
  '- The note excerpt in the user message is authoritative. Quote its text exactly and never invent note content, headings, values, or line numbers that are not there. If the note does not contain what the user refers to, say so.',
  '- The " │ " gutter and its leading number are NOT note text. old_text_anchor and target_excerpt repeat the note text at the chosen lines exactly, gutter excluded; line numbers come from that gutter.',
  '- If the target is genuinely ambiguous (an unresolved "that", "this part", "the number"), ask ONE short clarifying question instead of guessing. A wrong edit is worse than a question.',
  '- Never copy the user\'s command words into the note; write the note text yourself, matching the note\'s own style.',
  '- Every parameter name belongs to exactly one tool; never mix parameter vocabularies.',
  '',
  'TOOLS',
  renderWorkerChatToolCatalog(),
].join('\n')

// --- turn input -----------------------------------------------------------------

/** One prior turn, distilled: the command and the model's own visible reply. */
export interface WorkerChatHistoryTurn {
  command: string
  reply?: string
}

export interface WorkerChatLastRun {
  command: string
  status: string
  message?: string
}

/** The one retry the pipeline allows, carrying the rejected reply + exact error. */
export interface WorkerChatRetry {
  attemptText: string
  error: string
}

export interface WorkerChatInput {
  command: string
  /** Prior turns, oldest first (the last HISTORY_TURNS are used). */
  history: WorkerChatHistoryTurn[]
  /** Current full note text — always sent whole (the worker grounds its own span). */
  note: string
  lastRun?: WorkerChatLastRun | null
  /** Barge-in signal forwarded to the bridge stream. */
  signal?: AbortSignal
  /**
   * Visible-text callback: only text OUTSIDE <think> blocks is forwarded, so
   * the bubble never shows private deliberation. The final result.text is
   * authoritative (sanitized).
   */
  onText?: (delta: string) => void
  /** The single invalid-reply retry, when the pipeline runs one. */
  retry?: WorkerChatRetry
  /** Injectable bridge chat call (tests); defaults to the live 1.7B endpoint. */
  chat?: WorkerChatFn
}

export function buildWorkerChatMessages(input: WorkerChatInput): ChatMessage[] {
  const history = input.history.slice(-HISTORY_TURNS).flatMap((turn): ChatMessage[] => {
    const user: ChatMessage = { role: 'user', content: truncate(turn.command, HISTORY_TURN_CHARS) }
    if (turn.reply && turn.reply.trim()) {
      return [user, { role: 'assistant', content: truncate(turn.reply, HISTORY_TURN_CHARS) }]
    }
    return [user]
  })

  // The full note, always — never the outline. This mode has no Omni
  // front door: the 1.7B grounds the span itself, and an outline-only
  // turn cannot author a valid call (it invents note content instead).
  // The worker-chat prompt never sends the truncated variant; the cap
  // from omni.ts's §6 context policy does not apply here.
  const textParts = [
    `Current note (${NOTE_PATH}):\n${input.note}`,
    input.lastRun
      ? `Last completed run: "${input.lastRun.command}" → ${input.lastRun.status}${
          input.lastRun.message ? ` (${input.lastRun.message})` : ''
        }`
      : 'No edits have been committed yet this session.',
    `User: ${input.command}`,
  ].join('\n\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: WORKER_CHAT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: textParts },
  ]

  if (!input.retry) return messages
  // Attempt-2 conversation: the rejected reply as the assistant turn and the
  // concrete correction as prose (no fill-in XML skeleton to echo — the
  // packet worker's retry lesson).
  return [
    ...messages,
    { role: 'assistant', content: input.retry.attemptText.slice(0, 8_000) },
    {
      role: 'user',
      content:
        `That reply was rejected: ${input.retry.error} ` +
        'Reply again — either plain prose that answers the user (no XML at all), or exactly one ' +
        'complete <tool_call> block with every required parameter and nothing after it. Do not ' +
        'repeat the rejected reply.',
    },
  ]
}

// --- think-channel stripping ----------------------------------------------------

/**
 * Everything visible in the reply so far: complete <think> blocks removed, an
 * unclosed <think> block dropped to the end, and a trailing partial think tag
 * held back until it either completes or is confirmed as prose. Recomputed
 * from the full raw text each time so the streamed deltas never duplicate.
 */
export function visibleWorkerChatText(raw: string): string {
  let visible = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
  const unclosed = visible.search(/<think\b/i)
  if (unclosed >= 0) visible = visible.slice(0, unclosed)
  // A stray closing tag left by a malformed reply is never user text.
  visible = visible.replace(/<\/think>/gi, ' ')
  // Hold back a trailing partial think tag ("<thi", "</thin", …) until it
  // completes or turns out to be prose. A bare "<" is held too: it may be
  // the start of a tag, and the next delta decides.
  const partial = /<\/?[a-z]*$/i.exec(visible)?.[0]
  if (partial) {
    const tail = partial.toLowerCase()
    if ('<think>'.startsWith(tail) || '</think>'.startsWith(tail)) {
      visible = visible.slice(0, visible.length - partial.length)
    }
  }
  return visible
}

/** Visible/TTS hygiene: think channel first, then omni.ts's tool-marker scrub. */
export function sanitizeWorkerChatText(text: string): string {
  return sanitizeOmniText(visibleWorkerChatText(text))
}

// --- outcome --------------------------------------------------------------------

export type WorkerChatOutcome = 'answer' | 'delegate' | 'invalid'

export interface WorkerChatTurnResult {
  outcome: WorkerChatOutcome
  /** Sanitized visible text for an `answer` (prose only, no XML/function markers). */
  text?: string
  /** The parsed call for a `delegate`. */
  call?: ParsedToolCall
  /** The reply's reasoning channel, when one was emitted. */
  think?: string
  /** The raw model text, for the trace and the retry append. */
  raw: string
  /** The exact reason an `invalid` reply was unusable. */
  error?: string
  ms: number
  promptTokens?: number
  outputTokens?: number
}

/**
 * Run one worker-chat turn. Outcomes: `answer` (usable visible prose),
 * `delegate` (exactly one parseable tool call), or `invalid` (no parseable
 * call and no usable text — the pipeline retries once with `retry`, then
 * fails honestly). Transport failures throw WorkerChatError('endpoint');
 * nothing is ever invented to fill a reply.
 */
export async function runWorkerChatTurn(input: WorkerChatInput): Promise<WorkerChatTurnResult> {
  const chat = input.chat ?? defaultChat
  const started = performance.now()

  let raw = ''
  let emitted = ''
  const onToken = (delta: string) => {
    raw += delta
    if (!input.onText) return
    const visible = visibleWorkerChatText(raw)
    if (!visible.startsWith(emitted)) {
      // Defensive resync (never expected): adopt without re-emitting.
      emitted = visible
      return
    }
    const next = visible.slice(emitted.length)
    if (next) {
      emitted = visible
      input.onText(next)
    }
  }

  let completion: ChatResult
  try {
    completion = await chat(buildWorkerChatMessages(input), {
      temperature: WORKER_CHAT_TEMPERATURE,
      maxTokens: WORKER_CHAT_MAX_TOKENS,
      signal: input.signal,
      onToken,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new WorkerChatError('endpoint', `LFM3-1.7B chat failed: ${detail}`)
  }

  const text = completion.text
  const reasoning = completion.reasoning.trim()
  // The 1.7B may deliver reasoning as `reasoning_content` (bridge maps it to
  // `reasoning`) instead of inline <think>, or as both — parse either shape.
  const xmlInput =
    /<think\b/i.test(text) || !reasoning ? text : `<think>${reasoning}</think>\n${text}`
  const parsed = parseToolCallXml(xmlInput)
  const result = (fields: Partial<WorkerChatTurnResult>): WorkerChatTurnResult => ({
    outcome: 'invalid',
    raw: text,
    ms: Number((performance.now() - started).toFixed(1)),
    ...(completion.usage.promptTokens ? { promptTokens: completion.usage.promptTokens } : {}),
    ...(completion.usage.outputTokens ? { outputTokens: completion.usage.outputTokens } : {}),
    ...fields,
  })

  if (parsed) {
    return result({
      outcome: 'delegate',
      call: parsed,
      ...(parsed.think ? { think: parsed.think } : reasoning ? { think: reasoning } : {}),
    })
  }

  const visible = sanitizeWorkerChatText(text)
  if (visible) return result({ outcome: 'answer', text: visible })

  return result({
    outcome: 'invalid',
    error:
      'the reply contained no parseable tool call and no visible text after stripping the ' +
      'reasoning channel',
  })
}
