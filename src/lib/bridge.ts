/**
 * Native LFM3 model bridge.
 *
 * Talks to the local llama.cpp family servers started by
 * ~/Documents/Models/lfm3.sh — the app runs on the three-model trinity:
 *
 *   LFM3-Omni-2B   :8083  chat + ASR (/v1/audio/transcriptions)
 *   LFM3-1.7B      :8080  worker XML tool calls (text mutations, 256K ctx)
 *   d1-Omni-2B     :8085  routing / critic decisions (/v1/systemone)
 *
 * LFM3-VL-2B (:8081) was removed from the runtime in 2026-11-08: the 1.7B plus
 * the deterministic emitter cover every tool, and probing an optional fourth
 * server left a permanent connection-refused error in the console.
 *
 * Every caller is live-first: on failure it falls back to the local
 * deterministic layer and the trace records which path ran.
 */

import type { D1Answer, EndpointHealth, RuntimeHealth } from '../types'
import { isRecord, readNumber, readString } from './utils'

export interface EndpointSpec {
  id: EndpointHealth['id']
  name: string
  role: string
  port: number
  alias: string
}

export const ENDPOINTS: EndpointSpec[] = [
  { id: 'omni', name: 'LFM3-Omni-2B', role: 'Interface · chat + ASR + TTS', port: 8083, alias: 'lfm3-omni-2b' },
  { id: 'd1omni', name: 'd1-Omni-2B', role: 'Supervisor · route/critic', port: 8085, alias: 'd1-omni-2b' },
  { id: 'text', name: 'LFM3-1.7B', role: 'Worker · tool calls', port: 8080, alias: 'lfm3-1.7b' },
]

const DEFAULT_TIMEOUT_MS = 30_000

export class BridgeError extends Error {}

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal })
    const text = await response.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    if (!response.ok) {
      let detail = text
      if (isRecord(payload) && isRecord(payload.error)) {
        const message = readString(payload.error, 'message')
        if (message) detail = message
      }
      throw new BridgeError(`HTTP ${response.status}: ${(detail || response.statusText).slice(0, 240)}`)
    }
    return payload
  } catch (error) {
    if (error instanceof BridgeError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new BridgeError(`Request timed out after ${timeoutMs / 1000}s`)
    }
    throw new BridgeError(error instanceof Error ? error.message : 'Network failure')
  } finally {
    window.clearTimeout(timer)
  }
}

// --- health ------------------------------------------------------------------

export async function probeEndpoint(spec: EndpointSpec): Promise<EndpointHealth> {
  const url = `http://127.0.0.1:${spec.port}`
  const started = performance.now()
  try {
    const payload = await fetchJson(`${url}/v1/models`, { method: 'GET', timeoutMs: 4000 })
    const modelList =
      isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : []
    const models = modelList
      .map((model) =>
        isRecord(model) ? (readString(model, 'id') ?? readString(model, 'name') ?? '') : '',
      )
      .filter(Boolean)
    return {
      id: spec.id,
      name: spec.name,
      role: spec.role,
      port: spec.port,
      url,
      up: true,
      latencyMs: Math.round(performance.now() - started),
      models,
    }
  } catch (error) {
    return {
      id: spec.id,
      name: spec.name,
      role: spec.role,
      port: spec.port,
      url,
      up: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : 'unreachable',
    }
  }
}

export async function probeRuntime(): Promise<RuntimeHealth> {
  const endpoints = await Promise.all(ENDPOINTS.map(probeEndpoint))
  return { at: Date.now(), endpoints }
}

export function endpointUp(health: RuntimeHealth | null, id: EndpointHealth['id']): boolean {
  return health?.endpoints.some((endpoint) => endpoint.id === id && endpoint.up) ?? false
}

// --- usage -------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number
  outputTokens: number
}

function usageOf(payload: unknown): TokenUsage {
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {}
  return {
    promptTokens: readNumber(usage, 'prompt_tokens') ?? readNumber(usage, 'input_tokens') ?? 0,
    outputTokens: readNumber(usage, 'completion_tokens') ?? readNumber(usage, 'output_tokens') ?? 0,
  }
}

// --- chat completions (Omni) --------------------------------------------------

export type ChatContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

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
  maxTokens?: number
  stop?: string[]
  /** Function definitions offered to the model for this call. */
  tools?: ToolDef[]
}

export interface ChatStreamOptions extends ChatOptions {
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

function readCompletionChoice(payload: unknown): {
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
function measuredUsage(payload: unknown): TokenUsage | null {
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
  const payload = await fetchJson(`http://127.0.0.1:${spec.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: spec.alias,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 700,
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
    const response = await fetch(`http://127.0.0.1:${spec.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: spec.alias,
        messages,
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens ?? 700,
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

// --- ASR (Omni) --------------------------------------------------------------

export interface TranscriptResult {
  text: string
  ms: number
  usage: TokenUsage
}

export async function transcribeAudio(
  blob: Blob,
  endpoint: 'omni' | 'd1omni' = 'omni',
): Promise<TranscriptResult> {
  const spec = ENDPOINTS.find((candidate) => candidate.id === endpoint)
  if (!spec) throw new BridgeError(`${endpoint} endpoint missing`)
  const started = performance.now()
  const form = new FormData()
  form.append('file', blob, 'capture.wav')
  form.append('response_format', 'json')
  const payload = await fetchJson(`http://127.0.0.1:${spec.port}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    timeoutMs: 45_000,
  })
  const text = ((isRecord(payload) ? readString(payload, 'text') : undefined) ?? '').trim()
  if (!text) throw new BridgeError('Transcription came back empty')
  return {
    text,
    ms: Number((performance.now() - started).toFixed(1)),
    usage: usageOf(payload),
  }
}

// --- TTS (Omni) --------------------------------------------------------------

/**
 * Model TTS. `endpoint` names the Omni-architecture server that speaks:
 * 'omni' (:8083) in the Omni-first mode, 'd1omni' (:8085) in worker-d1
 * (same Omni architecture). Low-RAM never calls this — the caller uses the
 * browser voice instead.
 */
export async function synthesizeSpeech(
  text: string,
  options: { signal?: AbortSignal; endpoint?: 'omni' | 'd1omni' } = {},
): Promise<Blob> {
  const endpoint = options.endpoint ?? 'omni'
  const spec = ENDPOINTS.find((candidate) => candidate.id === endpoint)
  if (!spec) throw new BridgeError(`${endpoint} endpoint missing`)
  const response = await fetch(`http://127.0.0.1:${spec.port}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, response_format: 'wav' }),
    signal: options.signal,
  })
  if (!response.ok) {
    throw new BridgeError(`TTS failed: HTTP ${response.status}`)
  }
  const blob = await response.blob()
  if (!blob.size) throw new BridgeError('TTS returned empty audio')
  return blob
}

// --- d1 systemone (decision model) -------------------------------------------

export type D1Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string }

export interface D1DecideResult {
  answers: Record<string, D1Answer>
  ms: number
  usage: TokenUsage
}

function parseD1Answer(value: unknown): D1Answer | undefined {
  if (!isRecord(value)) return undefined
  switch (readString(value, 'type')) {
    case 'choice': {
      const choice = readString(value, 'choice')
      if (!choice) return undefined
      const probabilities: Record<string, number> = {}
      if (isRecord(value.probabilities)) {
        for (const [key, prob] of Object.entries(value.probabilities)) {
          if (typeof prob === 'number') probabilities[key] = prob
        }
      }
      return { type: 'choice', choice, probabilities }
    }
    case 'score': {
      const score = readNumber(value, 'score')
      return score == null ? undefined : { type: 'score', score }
    }
    case 'noul': {
      const noul = readNumber(value, 'noul')
      return noul == null ? undefined : { type: 'noul', noul }
    }
    default:
      return undefined
  }
}

export async function d1Decide(payload: {
  state?: string
  imageDataUrl?: string
  questions: Record<string, D1Question>
  /** Per-call deadline; span grounding uses a tighter budget than routing. */
  timeoutMs?: number
}): Promise<D1DecideResult> {
  const spec = ENDPOINTS.find((candidate) => candidate.id === 'd1omni')
  if (!spec) throw new BridgeError('d1 endpoint missing')
  const started = performance.now()
  const body: Record<string, unknown> = { questions: payload.questions }
  if (payload.state != null && payload.state.length) body.state = payload.state
  if (payload.imageDataUrl) body.images = [payload.imageDataUrl]
  const result = await fetchJson(`http://127.0.0.1:${spec.port}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: payload.timeoutMs ?? 30_000,
  })
  const answers: Record<string, D1Answer> = {}
  if (isRecord(result) && isRecord(result.answers)) {
    for (const [id, value] of Object.entries(result.answers)) {
      const answer = parseD1Answer(value)
      if (answer) answers[id] = answer
    }
  }
  if (!Object.keys(answers).length) throw new BridgeError('d1 returned no usable answers')
  return {
    answers,
    ms: Number((performance.now() - started).toFixed(1)),
    usage: usageOf(result),
  }
}
