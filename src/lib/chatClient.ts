/**
 * OpenAI-style chat completions against a local llama.cpp family server.
 *
 * `chatComplete` is the single-shot call; `chatCompleteStream` parses SSE
 * `data:` chunks and forwards deltas. Both are live-first: any transport
 * failure surfaces as a `BridgeError` and the caller falls back.
 */

import type { EndpointHealth } from '../types'
import { isRecord, readNumber, readString } from './utils'
import { BridgeError, ENDPOINTS, fetchJson, modelUrl } from './endpoints'

// --- usage -------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number
  outputTokens: number
}

export function usageOf(payload: unknown): TokenUsage {
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {}
  return {
    promptTokens: readNumber(usage, 'prompt_tokens') ?? readNumber(usage, 'input_tokens') ?? 0,
    outputTokens: readNumber(usage, 'completion_tokens') ?? readNumber(usage, 'output_tokens') ?? 0,
  }
}

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

export function readCompletionChoice(payload: unknown): {
  text: string
  reasoning: string
  toolCalls: ToolCallRequest[]
  finishReason: string | null
} {
  const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : []
  const first = isRecord(choices[0]) ? choices[0] : {}
  const message = isRecord(first.message) ? first.message : {}
  const toolCalls: ToolCallRequest[] = []
  if (Array.isArray(message.tool_calls)) {
    for (const entry of message.tool_calls) {
      if (!isRecord(entry)) continue
      const fn = isRecord(entry.function) ? entry.function : {}
      const name = readString(fn, 'name')
      if (!name) continue
      toolCalls.push({
        id: readString(entry, 'id') ?? `call-${toolCalls.length + 1}`,
        type: 'function',
        function: { name, arguments: readString(fn, 'arguments') ?? '' },
      })
    }
  }
  return {
    text: (readString(message, 'content') ?? '').trim(),
    reasoning: (readString(message, 'reasoning_content') ?? '').trim(),
    toolCalls,
    finishReason: readString(first, 'finish_reason') ?? null,
  }
}

/** llama.cpp reports real token counts in the final chunk's `timings` object. */
export function measuredUsage(payload: unknown): TokenUsage | null {
  if (!isRecord(payload) || !isRecord(payload.timings)) return null
  const promptTokens = readNumber(payload.timings, 'prompt_n')
  const outputTokens = readNumber(payload.timings, 'predicted_n')
  if (promptTokens == null || outputTokens == null) return null
  return { promptTokens, outputTokens }
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

/**
 * Streamed chat completion: POST `stream: true`, parse SSE `data:` chunks,
 * forward each `delta.content` to `onToken`, resolve with the full text.
 *
 * `ms` is measured wall-clock for the whole stream. `usage` carries llama.cpp's
 * own token counts when the server reports them, zero otherwise — never a guess.
 */
export async function chatCompleteStream(
  endpoint: EndpointHealth['id'],
  messages: ChatMessage[],
  options: ChatStreamOptions = {},
): Promise<ChatResult> {
  const spec = ENDPOINTS.find((candidate) => candidate.id === endpoint)
  if (!spec) throw new BridgeError(`Unknown endpoint ${endpoint}`)
  const started = performance.now()
  const timeout = new AbortController()
  const timer = window.setTimeout(() => timeout.abort(), 90_000)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal
  try {
    const response = await fetch(modelUrl(spec.port, '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: spec.alias,
        messages,
        temperature: options.temperature ?? 0.1,
        ...(options.maxTokens === null ? {} : { max_tokens: options.maxTokens ?? 700 }),
        ...(options.stop?.length ? { stop: options.stop } : {}),
        ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}),
        stream: true,
      }),
      signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new BridgeError(
        `HTTP ${response.status}: ${(detail || response.statusText).slice(0, 240)}`,
      )
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) {
      // Server ignored `stream`; accept the single JSON body instead.
      const payload: unknown = await response.json().catch(() => null)
      const { text, reasoning, toolCalls, finishReason } = readCompletionChoice(payload)
      if (!text && !reasoning && !toolCalls.length) {
        throw new BridgeError('Model returned an empty completion')
      }
      if (text) options.onToken?.(text)
      return {
        text,
        reasoning,
        ms: Number((performance.now() - started).toFixed(1)),
        usage: usageOf(payload),
        toolCalls,
        finishReason,
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let reasoning = ''
    let usage: TokenUsage = { promptTokens: 0, outputTokens: 0 }
    let finished = false
    let finishReason: string | null = null
    // Tool-call deltas arrive fragmented, keyed by `index` — accumulate the
    // fragments per slot and assemble the complete calls at stream end.
    const toolCallSlots = new Map<number, { id: string; name: string; arguments: string }>()

    while (!finished) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') {
          finished = true
          break
        }
        let chunk: unknown
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        const timings = measuredUsage(chunk)
        if (timings) usage = timings
        if (isRecord(chunk) && isRecord(chunk.usage)) usage = usageOf(chunk)
        const choices = isRecord(chunk) && Array.isArray(chunk.choices) ? chunk.choices : []
        const first = isRecord(choices[0]) ? choices[0] : {}
        const reason = readString(first, 'finish_reason')
        if (reason) finishReason = reason
        const delta = isRecord(first.delta) ? first.delta : {}
        const content = readString(delta, 'content')
        if (content) {
          text += content
          options.onToken?.(content)
        }
        const reasoningDelta = readString(delta, 'reasoning_content')
        if (reasoningDelta) reasoning += reasoningDelta
        if (Array.isArray(delta.tool_calls)) {
          for (const entry of delta.tool_calls) {
            if (!isRecord(entry)) continue
            const index = typeof entry.index === 'number' ? entry.index : 0
            const fn = isRecord(entry.function) ? entry.function : {}
            const slot = toolCallSlots.get(index) ?? { id: '', name: '', arguments: '' }
            const id = readString(entry, 'id')
            if (id) slot.id = id
            const name = readString(fn, 'name')
            if (name) slot.name += name
            const args = readString(fn, 'arguments')
            if (args) slot.arguments += args
            toolCallSlots.set(index, slot)
          }
        }
      }
    }
    await reader.cancel().catch(() => {})

    const toolCalls: ToolCallRequest[] = [...toolCallSlots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot], position) => ({
        id: slot.id || `call-${position + 1}`,
        type: 'function' as const,
        function: { name: slot.name, arguments: slot.arguments },
      }))
      .filter((call) => call.function.name)

    const trimmed = text.trim()
    const trimmedReasoning = reasoning.trim()
    if (!trimmed && !trimmedReasoning && !toolCalls.length) {
      throw new BridgeError('Model returned an empty completion')
    }
    return {
      text: trimmed,
      reasoning: trimmedReasoning,
      ms: Number((performance.now() - started).toFixed(1)),
      usage,
      toolCalls,
      finishReason,
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new BridgeError(
        options.signal?.aborted ? 'Stream aborted' : 'Request timed out after 90s',
      )
    }
    throw new BridgeError(error instanceof Error ? error.message : 'Network failure')
  } finally {
    window.clearTimeout(timer)
  }
}
