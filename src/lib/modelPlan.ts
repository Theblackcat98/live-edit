/**
 * Mode-switch model planning: which llama.cpp members a run mode needs, and
 * what a switch would start or leave loaded. Pure decisions — the manager
 * client (modelManager.ts) and the daemon (scripts/model-manager.mjs) act on
 * them. UI honesty rules apply: the plan names real members and ports, and
 * stopping a loaded member is always opt-in.
 */

import type { EndpointHealth, RuntimeHealth } from '../types'
import type { RunMode } from './runmode'

export type EndpointId = EndpointHealth['id']

/** Manager member names (scripts/model-manager.mjs); ids differ only for d1. */
const MANAGER_NAMES: Record<EndpointId, string> = {
  omni: 'omni',
  d1omni: 'd1-omni',
  text: 'text',
  audio: 'audio',
}

export function managerNameFor(id: EndpointId): string {
  return MANAGER_NAMES[id]
}

/**
 * The endpoints a mode actually runs — rosterFor(mode) (src/data/models.ts)
 * mapped to the servers behind it.
 */
export function endpointsForMode(mode: RunMode): EndpointId[] {
  if (mode === 'audio') return ['audio', 'd1omni', 'text']
  if (mode === 'omni') return ['omni', 'd1omni', 'text']
  if (mode === 'worker-d1') return ['text', 'd1omni']
  return ['text']
}

export interface ModelSwitchPlan {
  mode: RunMode
  /** Required by the target mode but not answering now. */
  toStart: EndpointId[]
  /** Answering now but unused by the target mode — stopping is opt-in. */
  spareLoaded: EndpointId[]
}

/**
 * Diff a target mode against current health. `health` may be stale or null
 * (probe window): a stale-up member makes start a no-op (the manager is
 * idempotent), a stale-down member only costs an extra confirm.
 */
export function planModelSwitch(next: RunMode, health: RuntimeHealth | null): ModelSwitchPlan {
  const required = endpointsForMode(next)
  const up = new Set(health?.endpoints.filter((endpoint) => endpoint.up).map((endpoint) => endpoint.id) ?? [])
  return {
    mode: next,
    toStart: required.filter((id) => !up.has(id)),
    // ENDPOINTS order, so the dialog list is deterministic.
    spareLoaded: (['omni', 'd1omni', 'text', 'audio'] as EndpointId[]).filter(
      (id) => up.has(id) && !required.includes(id),
    ),
  }
}
