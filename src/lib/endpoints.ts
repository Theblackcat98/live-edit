/**
 * Native LFM3 model bridge — endpoints and transport.
 *
 * Talks to the local llama.cpp family servers started by
 * scripts/start-models.sh. Which of them a run mode needs is the mode's
 * `endpoints` row in modes.ts:
 *
 *   LFM3-Audio-2B  :8086  front door (default audio mode): chat + ASR + TTS
 *   LFM3-Omni-2B   :8083  legacy front door (omni mode)
 *   LFM3-1.7B      :8080  worker XML tool calls (text mutations, -c 128000)
 *   d1-Omni-2B     :8085  turn routing + safety-check decisions (/v1/systemone)
 *
 * There is no deterministic stand-in for a model: when a server is down the
 * affected stage degrades honestly (the turn fails, or the edit is held for
 * the user) and the trace records which path ran (design.md §1).
 */

import type { EndpointHealth, RuntimeHealth } from '../types'
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
  { id: 'd1omni', name: 'd1-Omni-2B', role: 'Safety check · d1', port: 8085, alias: 'd1-omni-2b' },
  { id: 'text', name: 'LFM3-1.7B', role: 'Worker · tool calls', port: 8080, alias: 'lfm3-1.7b' },
  { id: 'audio', name: 'LFM3-Audio-2B', role: 'Interface · chat + ASR + TTS', port: 8086, alias: 'lfm3-audio-2b' },
]

const DEFAULT_TIMEOUT_MS = 30_000

export class BridgeError extends Error {}

/**
 * Model-server host, resolved from the page that served this tab. The model
 * servers bind 0.0.0.0, so a LAN client reaches them through the same host
 * it loaded the page from — a hardcoded 127.0.0.1 would be the client
 * itself. Loopback stays loopback on desktop; no window (tests) keeps it.
 */
export function modelHost(): string {
  const hostname = typeof window !== 'undefined' ? window.location?.hostname : undefined
  if (!hostname) return '127.0.0.1'
  return hostname.includes(':') ? `[${hostname}]` : hostname
}

/** Model-server URL for a port + path, honoring the page's host. */
export function modelUrl(port: number, path: string): string {
  return `http://${modelHost()}:${port}${path}`
}

export async function fetchJson(
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

/** Model ids from a /v1/models payload: OpenAI `data[]` and llama.cpp's `models[]`. */
export function listedModels(payload: unknown): string[] {
  if (!isRecord(payload)) return []
  const ids = new Set<string>()
  for (const key of ['data', 'models'] as const) {
    const list = payload[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!isRecord(entry)) continue
      const id = readString(entry, 'id') ?? readString(entry, 'model') ?? readString(entry, 'name')
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

/** The runtime context window from a llama.cpp /props payload, when present. */
export function contextFromProps(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined
  const settings = isRecord(payload.default_generation_settings) ? payload.default_generation_settings : {}
  const value = readNumber(settings, 'n_ctx') ?? readNumber(payload, 'n_ctx')
  return value && value > 0 ? value : undefined
}

export async function probeEndpoint(spec: EndpointSpec): Promise<EndpointHealth> {
  const url = modelUrl(spec.port, '')
  const started = performance.now()
  const base = { id: spec.id, name: spec.name, role: spec.role, port: spec.port, url }
  try {
    const payload = await fetchJson(`${url}/v1/models`, { method: 'GET', timeoutMs: 4000 })
    const latencyMs = Math.round(performance.now() - started)
    const models = listedModels(payload)
    // A server that lists models but not ours is up — serving the wrong thing.
    const matches = models.some((model) => model === spec.alias || model.includes(spec.alias))
    let contextTokens: number | undefined
    try {
      contextTokens = contextFromProps(await fetchJson(`${url}/props`, { method: 'GET', timeoutMs: 2000 }))
    } catch {
      // /props is optional; the context window then stays the configured one.
    }
    return {
      ...base,
      up: true,
      latencyMs,
      models,
      ...(models.length && !matches ? { unexpectedModel: models[0] } : {}),
      ...(contextTokens ? { contextTokens } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreachable'
    return {
      ...base,
      up: false,
      latencyMs: Math.round(performance.now() - started),
      error: message,
      // llama.cpp answers 503 while the weights load: starting, not down.
      ...(/^HTTP 503\b/.test(message) ? { loading: true } : {}),
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
