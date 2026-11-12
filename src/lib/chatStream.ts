/**
 * Streamed chat completion against a local llama.cpp family server.
 *
 * POST `stream: true`, parse SSE `data:` chunks, forward each `delta.content`
 * to `onToken`, resolve with the full text. Imported through `chatClient`.
 */

import type { EndpointHealth } from '../types'
import { isRecord, readString } from './utils'
import { BridgeError, ENDPOINTS, modelUrl } from './endpoints'
import {
  measuredUsage,
  optionalServerFacts,
  readCompletionChoice,
  servedModelOf,
  serverTimingsOf,
  usageOf,
  type ServerTimings,
  type TokenUsage,
} from './completion'
import type {
  ChatMessage,
  ChatResult,
  ChatStreamOptions,
  ToolCallRequest,
} from './chatClient'

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
        ...optionalServerFacts(payload),
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
    let servedModel: string | undefined
    let serverTimings: ServerTimings | undefined
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
        servedModel = servedModelOf(chunk) ?? servedModel
        serverTimings = serverTimingsOf(chunk) ?? serverTimings
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
      ...(servedModel ? { servedModel } : {}),
      ...(serverTimings ? { serverTimings } : {}),
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
