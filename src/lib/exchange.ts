/**
 * Turn-exchange recorder (the Chat tab of the turn inspector): every
 * request/response pair a turn makes against a model server is captured
 * verbatim — the exact message array the model saw, the sampler sent, the
 * reasoning/reply/tool calls that came back, and the error when it failed.
 * omni.ts, workerChat.ts and the packet-worker loop in pipeline.ts all
 * funnel through captureExchange, so conversational turns, retries and
 * failures are as inspectable as verified tool-call turns.
 */

import type { ChatMessage, ChatResult } from './bridge'
import { ENDPOINTS, modelUrl } from './bridge'
import type { ExchangeMessage, TurnExchange } from '../types'
import { makeId } from './utils'

/**
 * Per-message content cap for the RECORD only (the request itself is never
 * altered): a runaway note or reply must not bloat every exchange copy in
 * memory and the persisted run window. Generous enough that real prompts
 * (3,600-char note cap, 600-char history entries) never hit it.
 */
const EXCHANGE_CONTENT_CAP = 8_000

function capContent(content: string): string {
  if (content.length <= EXCHANGE_CONTENT_CAP) return content
  const hidden = content.length - EXCHANGE_CONTENT_CAP
  return `${content.slice(0, EXCHANGE_CONTENT_CAP)}\n[… +${hidden} chars not shown — record capped at ${EXCHANGE_CONTENT_CAP}]`
}

/** Serializable projection of the bridge's ChatMessage for display/persistence. */
export function projectExchangeMessages(messages: ChatMessage[]): ExchangeMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: capContent(message.content),
    ...(message.tool_calls
      ? {
          toolCalls: message.tool_calls.map((call) => ({
            name: call.function.name,
            arguments: capContent(call.function.arguments),
          })),
        }
      : {}),
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
  }))
}

/** Where the worker's exchanges land (LFM3-1.7B on :8080), resolved lazily so modelHost() reads the live page host. */
export function workerExchangeTarget(): { model: string; url: string } {
  const spec = ENDPOINTS.find((endpoint) => endpoint.id === 'text')
  return {
    model: spec?.name ?? 'LFM3-1.7B',
    url: modelUrl(spec?.port ?? 8080, '/v1/chat/completions'),
  }
}

export interface ExchangeCapture {
  role: TurnExchange['role']
  label: string
  model: string
  url: string
  messages: ChatMessage[]
  stream: boolean
  temperature: number
  maxTokens: number | null
  /** Tool-definition names attached to the request, when any. */
  tools?: string[]
  /** The completion, when the server answered; null on transport failure/abort. */
  completion?: ChatResult | null
  /** Why the exchange failed; present exactly when ok resolves false. */
  error?: string
  /**
   * Overrides the ok default (completion present, no error) for replies the
   * server returned but the caller rejected — e.g. an unparseable tool call.
   */
  rejected?: boolean
}

/** Assemble one recorded exchange; ok is derived unless explicitly rejected. */
export function captureExchange(capture: ExchangeCapture): TurnExchange {
  const ok = capture.rejected !== true && !capture.error && !!capture.completion
  const completion = capture.completion ?? null
  return {
    id: makeId('ex'),
    role: capture.role,
    label: capture.label,
    model: capture.model,
    url: capture.url,
    at: Date.now(),
    ms: completion?.ms ?? 0,
    ok,
    ...(capture.error ? { error: capture.error } : {}),
    request: {
      messages: projectExchangeMessages(capture.messages),
      stream: capture.stream,
      temperature: capture.temperature,
      maxTokens: capture.maxTokens,
      ...(capture.tools ? { tools: capture.tools } : {}),
    },
    ...(completion
      ? {
          response: {
            text: capContent(completion.text),
            reasoning: capContent(completion.reasoning),
            toolCalls: completion.toolCalls.map((call) => ({
              name: call.function.name,
              arguments: capContent(call.function.arguments),
            })),
            promptTokens: completion.usage.promptTokens,
            outputTokens: completion.usage.outputTokens,
            finishReason: completion.finishReason,
          },
        }
      : {}),
  }
}
