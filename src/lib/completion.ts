/**
 * Completion parsing and token accounting shared by the chat, ASR and d1
 * clients. Pure functions over a decoded JSON payload — no transport here.
 */

import { isRecord, readNumber, readString } from './utils'
import type { ToolCallRequest } from './chatClient'

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

/** llama.cpp's per-request performance figures (the `timings` object). */
export interface ServerTimings {
  /** Prompt processing time, ms. */
  promptMs?: number
  /** Generation time, ms. */
  predictedMs?: number
  /** Generation speed, tokens per second. */
  tokensPerSecond?: number
  /** Prompt tokens served from the server's prompt cache. */
  cachedTokens?: number
}

/** The `timings` (and cached-token usage detail) a llama.cpp payload reports. */
export function serverTimingsOf(payload: unknown): ServerTimings | undefined {
  if (!isRecord(payload)) return undefined
  const timings = isRecord(payload.timings) ? payload.timings : {}
  const usage = isRecord(payload.usage) ? payload.usage : {}
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const out: ServerTimings = {}
  const promptMs = readNumber(timings, 'prompt_ms')
  const predictedMs = readNumber(timings, 'predicted_ms')
  const tokensPerSecond = readNumber(timings, 'predicted_per_second')
  const cachedTokens = readNumber(timings, 'cache_n') ?? readNumber(details, 'cached_tokens')
  if (promptMs != null) out.promptMs = promptMs
  if (predictedMs != null) out.predictedMs = predictedMs
  if (tokensPerSecond != null) out.tokensPerSecond = tokensPerSecond
  if (cachedTokens != null) out.cachedTokens = cachedTokens
  return Object.keys(out).length ? out : undefined
}

/** The model id the server says produced this completion. */
export function servedModelOf(payload: unknown): string | undefined {
  return isRecord(payload) ? readString(payload, 'model') : undefined
}

/** servedModel + serverTimings from a payload, omitting what was not reported. */
export function optionalServerFacts(payload: unknown): {
  servedModel?: string
  serverTimings?: ServerTimings
} {
  const servedModel = servedModelOf(payload)
  const serverTimings = serverTimingsOf(payload)
  return { ...(servedModel ? { servedModel } : {}), ...(serverTimings ? { serverTimings } : {}) }
}
