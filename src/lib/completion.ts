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
