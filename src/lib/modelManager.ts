/**
 * Client for the local model-manager daemon (scripts/model-manager.mjs serve,
 * npm run models:manager). The daemon owns spawning llama.cpp members; this
 * client only reaches it over loopback HTTP. When the daemon is not running
 * the app must behave exactly as before — managerStatus() resolves null and
 * nothing else is attempted.
 */

import { modelHost } from './bridge'
import { isRecord } from './utils'

export const MANAGER_PORT = 8199

export class ModelManagerError extends Error {}

export interface ManagerMember {
  name: string
  port: number
  up: boolean
  starting: boolean
  pid: number | null
}

export interface ManagerStatus {
  members: ManagerMember[]
}

export interface ManagerResult {
  name: string
  action: string
  detail?: string
}

function managerUrl(path: string): string {
  return `http://${modelHost()}:${MANAGER_PORT}${path}`
}

async function managerRequest(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const { timeoutMs = 2500, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(managerUrl(path), { ...rest, signal: controller.signal })
    const text = await response.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    if (!response.ok) {
      const detail = isRecord(payload) && typeof payload.error === 'string' ? payload.error : text
      throw new ModelManagerError(`HTTP ${response.status}: ${String(detail).slice(0, 240)}`)
    }
    return payload
  } catch (error) {
    if (error instanceof ModelManagerError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ModelManagerError(`manager timed out after ${timeoutMs / 1000}s`)
    }
    throw new ModelManagerError(error instanceof Error ? error.message : 'manager unreachable')
  } finally {
    clearTimeout(timer)
  }
}

function parseMembers(payload: unknown): ManagerMember[] {
  if (!isRecord(payload) || !Array.isArray(payload.members)) {
    throw new ModelManagerError('malformed /status payload')
  }
  return payload.members.flatMap((raw): ManagerMember[] => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.port !== 'number') return []
    return [
      {
        name: raw.name,
        port: raw.port,
        up: raw.up === true,
        starting: raw.starting === true,
        pid: typeof raw.pid === 'number' ? raw.pid : null,
      },
    ]
  })
}

function parseResults(payload: unknown): ManagerResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new ModelManagerError('malformed mutation payload')
  }
  return payload.results.flatMap((raw): ManagerResult[] => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.action !== 'string') return []
    return [{ name: raw.name, action: raw.action, detail: typeof raw.detail === 'string' ? raw.detail : undefined }]
  })
}

/**
 * Daemon reachability + member state. Null means "not running / unreachable"
 * — the caller falls back to manual model management, never an error toast.
 */
export async function managerStatus(): Promise<ManagerStatus | null> {
  try {
    return { members: parseMembers(await managerRequest('/status', { method: 'GET', timeoutMs: 1500 })) }
  } catch {
    return null
  }
}

export async function managerStart(names: string[]): Promise<ManagerResult[]> {
  const payload = await managerRequest('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ names }),
  })
  return parseResults(payload)
}

export async function managerStop(names: string[]): Promise<ManagerResult[]> {
  const payload = await managerRequest('/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ names }),
  })
  return parseResults(payload)
}
