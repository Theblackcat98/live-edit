/**
 * Native LFM3 model bridge — endpoints and transport.
 *
 * Talks to the local llama.cpp family servers started by
 * ~/Documents/Models/lfm3.sh — the app runs on the three-model trinity:
 *
 *   LFM3-Omni-2B   :8083  chat + ASR (/v1/audio/transcriptions)
 *   LFM3-1.7B      :8080  worker XML tool calls (text mutations, -c 128000)
 *   d1-Omni-2B     :8085  safety-check decisions (/v1/systemone)
 *
 * LFM3-VL-2B (:8081) was removed from the runtime in 2026-11-08: the 1.7B plus
 * the deterministic emitter cover every tool, and probing an optional fourth
 * server left a permanent connection-refused error in the console.
 *
 * Every caller is live-first: on failure it falls back to the local
 * deterministic layer and the trace records which path ran.
 */

import type { EndpointHealth, RuntimeHealth } from '../types'
import { isRecord, readString } from './utils'

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

export async function probeEndpoint(spec: EndpointSpec): Promise<EndpointHealth> {
  const url = modelUrl(spec.port, '')
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
