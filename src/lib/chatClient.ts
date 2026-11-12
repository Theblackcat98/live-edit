/**
 * OpenAI-style chat completions against a local llama.cpp family server.
 *
 * `chatComplete` is the single-shot call; `chatCompleteStream` parses SSE
 * `data:` chunks and forwards deltas. Both are live-first: any transport
 * failure surfaces as a `BridgeError` and the caller falls back.
 */

import type { EndpointHealth } from '../types'
import { BridgeError, ENDPOINTS, fetchJson, modelUrl } from './endpoints'
import { readCompletionChoice, usageOf, type TokenUsage } from './completion'

export { chatCompleteStream } from './chatStream'
export { measuredUsage, readCompletionChoice, usageOf, type TokenUsage } from './completion'

// --- chat completions (Omni) --------------------------------------------------

/** Message content is plain text: no attachments travel with any request. */
export type ChatContent = string

// --- tool calling (OpenAI-style; needs llama.cpp --jinja) ----------------------
// Additive (P2, omni.ts): the chat calls can carry function definitions and
// return the function calls a completion made. Existing callers that never pass
// `tools` are unaffected — the body fields are only added when present.

/** An OpenAI-style function definition (`tools` array entry). */
export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON Schema describing the function's arguments object. */
    parameters: Record<string, unknown>
  }
}

/** A function call parsed out of a completion (assistant side). */
export interface ToolCallRequest {
  id: string
  type: 'function'
  function: {
    name: string
    /** Raw arguments — the caller parses/validates this JSON itself. */
    arguments: string
  }
}

export interface ChatMessage {
  /**
   * `tool` is the tool-result role: its `content` answers the assistant
   * `tool_calls` entry whose id matches `tool_call_id`.
   */
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ChatContent
  /** Assistant message only: the function calls made in that completion. */
  tool_calls?: ToolCallRequest[]
  /** Tool-role message only: id of the call this result answers. */
  tool_call_id?: string
}

export interface ChatResult {
  text: string
  reasoning: string
  ms: number
  usage: TokenUsage
  /** Function calls the completion made; empty when none (never undefined). */
  toolCalls: ToolCallRequest[]
  /** Last non-null finish_reason the server reported ("stop", "length", …). */
  finishReason: string | null
}

export interface ChatOptions {
  temperature?: number
  /**
   * Output cap sent as `max_tokens`. `null` explicitly OMITS the field — the
   * server generates until EOS or its context ends (an uncapped reply); the
   * fallback default when absent stays 700.
   */
  maxTokens?: number | null
  stop?: string[]
  /** Function definitions offered to the model for this call. */
  tools?: ToolDef[]
}

export interface ChatStreamOptions extends ChatOptions {
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

export async function chatComplete(
  endpoint: EndpointHealth['id'],
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  const spec = ENDPOINTS.find((candidate) => candidate.id === endpoint)
  if (!spec) throw new BridgeError(`Unknown endpoint ${endpoint}`)
  const started = performance.now()
  const payload = await fetchJson(modelUrl(spec.port, '/v1/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: spec.alias,
      messages,
      temperature: options.temperature ?? 0.1,
      ...(options.maxTokens === null ? {} : { max_tokens: options.maxTokens ?? 700 }),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}),
      stream: false,
    }),
  })
  const { text, reasoning, toolCalls, finishReason } = readCompletionChoice(payload)
  if (!text && !reasoning && !toolCalls.length) {
    throw new BridgeError('Model returned an empty completion')
  }
  return {
    text,
    reasoning,
    ms: Number((performance.now() - started).toFixed(1)),
    usage: usageOf(payload),
    toolCalls,
    finishReason,
  }
}
