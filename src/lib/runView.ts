/**
 * Shared display facts for runs and runtime health, so every surface (trace
 * drawer header, run strip, status bar, rail) says the same thing about the
 * same data instead of each inventing its own wording.
 */

import type { EndpointHealth, RunStatus, RuntimeHealth, Trace } from '../types'
import { modelHost } from './endpoints'
import { modeDef } from './modes'
import type { RunMode } from './runmode'

/** The one word a run's status reads as, everywhere it is shown. */
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'running':
      return 'running'
    case 'clarify':
      return 'clarify'
    case 'rejected':
      return 'stopped'
    case 'pending':
      return 'held for you'
    case 'failed':
      return 'failed'
    case 'conversational':
      return 'chat only'
    default:
      return 'applied'
  }
}

/** Semantic tone of a run status (maps to chip-* / is-* classes). */
export type RunTone = 'green' | 'orange' | 'red' | 'accent' | 'neutral'

export function runStatusTone(status: RunStatus): RunTone {
  switch (status) {
    case 'verified':
      return 'green'
    case 'clarify':
    case 'pending':
      return 'orange'
    case 'rejected':
    case 'failed':
      return 'red'
    case 'running':
      return 'accent'
    default:
      return 'neutral'
  }
}

/** Short display id for a run ("#4F2A"). */
export function runShortId(trace: Pick<Trace, 'id'>, length = 4): string {
  return `#${trace.id.slice(-length).toUpperCase()}`
}

/** Where the model servers are reached from this tab (honours LAN access). */
export function modelHostLabel(): string {
  return modelHost()
}

export interface ModeHealth {
  /** Endpoints this mode needs, with their probe state. */
  needed: EndpointHealth[]
  /** How many of the needed endpoints answered. */
  up: number
  /** Needed endpoints that did not answer. */
  down: EndpointHealth[]
  /** The subset of `down` that is still loading its weights (HTTP 503). */
  loading: EndpointHealth[]
  /** True when every endpoint the mode needs is up. */
  allUp: boolean
}

/**
 * Health scoped to the active mode. The probe checks every known server, but
 * a mode only needs some of them — the legacy Omni server being off is not a
 * problem in audio mode, and must not read as one.
 */
export function modeHealth(health: RuntimeHealth | null, mode: RunMode): ModeHealth | null {
  if (!health) return null
  const ids = modeDef(mode).endpoints
  const needed = health.endpoints.filter((endpoint) => ids.includes(endpoint.id))
  const down = needed.filter((endpoint) => !endpoint.up)
  const loading = down.filter((endpoint) => endpoint.loading)
  return { needed, up: needed.length - down.length, down, loading, allUp: down.length === 0 }
}

/** True when the endpoint is part of the mode's roster. */
export function usedByMode(id: EndpointHealth['id'], mode: RunMode): boolean {
  return modeDef(mode).endpoints.includes(id)
}

/** The stages that ran on a run, in pipeline order, with how they ran. */
export interface StageProvenance {
  id: 'asr' | 'chat' | 'route' | 'worker' | 'critic'
  label: string
  source: 'live' | 'fallback' | 'dictation'
}

const STAGE_LABELS: Record<StageProvenance['id'], string> = {
  asr: 'ASR',
  chat: 'Chat',
  route: 'Route',
  worker: 'Worker',
  critic: 'Safety check',
}

/** Runtime provenance for the stages that actually ran (skipped stages omitted). */
export function stageProvenance(trace: Trace): StageProvenance[] {
  const runtime = trace.runtime
  if (!runtime) return []
  const out: StageProvenance[] = []
  const push = (id: StageProvenance['id'], value: string | undefined) => {
    if (value === 'live' || value === 'fallback' || value === 'dictation') {
      out.push({ id, label: STAGE_LABELS[id], source: value })
    }
  }
  push('asr', runtime.asr)
  push('chat', runtime.chat)
  push('route', runtime.route)
  push('worker', runtime.worker)
  push('critic', runtime.critic)
  return out
}

/**
 * Output tokens for display, with whether a model server measured them. Only
 * a figure the servers reported is unqualified; anything else is marked as an
 * estimate by the caller.
 */
export function measuredOutputTokens(trace: Trace): { tokens: number; measured: boolean } {
  const reported = (trace.exchanges ?? []).reduce(
    (sum, exchange) => sum + (exchange.response?.outputTokens ?? 0),
    0,
  )
  if (reported > 0) return { tokens: reported, measured: true }
  return { tokens: trace.outputTokens, measured: false }
}
