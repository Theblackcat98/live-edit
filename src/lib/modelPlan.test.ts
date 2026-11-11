import { describe, expect, it } from 'vitest'
import type { EndpointHealth, RuntimeHealth } from '../types'
import { endpointsForMode, managerNameFor, planModelSwitch } from './modelPlan'

/** Health fixture: every listed endpoint answers, the rest are down. */
function healthWith(up: EndpointHealth['id'][]): RuntimeHealth {
  const all: EndpointHealth['id'][] = ['omni', 'd1omni', 'text', 'audio']
  return {
    at: 0,
    endpoints: all.map((id) => ({
      id,
      name: id,
      role: '',
      port: 0,
      url: '',
      up: up.includes(id),
      latencyMs: 1,
    })),
  }
}

describe('endpointsForMode', () => {
  it('audio runs the interface, the safety check and the worker', () => {
    expect(endpointsForMode('audio')).toEqual(['audio', 'd1omni', 'text'])
  })

  it('omni (legacy) swaps the interface, keeps d1 and the worker', () => {
    expect(endpointsForMode('omni')).toEqual(['omni', 'd1omni', 'text'])
  })

  it('worker-d1 needs exactly the worker and d1', () => {
    expect(endpointsForMode('worker-d1')).toEqual(['text', 'd1omni'])
  })

  it('lowram needs only the worker', () => {
    expect(endpointsForMode('lowram')).toEqual(['text'])
  })
})

describe('managerNameFor', () => {
  it('maps endpoint ids to manager member names', () => {
    expect(managerNameFor('d1omni')).toBe('d1-omni')
    expect(managerNameFor('text')).toBe('text')
    expect(managerNameFor('omni')).toBe('omni')
    expect(managerNameFor('audio')).toBe('audio')
  })
})

describe('planModelSwitch', () => {
  it('is empty when the target roster is exactly what answers', () => {
    const plan = planModelSwitch('worker-d1', healthWith(['text', 'd1omni']))
    expect(plan.toStart).toEqual([])
    expect(plan.spareLoaded).toEqual([])
  })

  it('starts missing members even when others are loaded', () => {
    const plan = planModelSwitch('audio', healthWith(['text', 'd1omni']))
    expect(plan.toStart).toEqual(['audio'])
    expect(plan.spareLoaded).toEqual([])
  })

  it('offers loaded members the mode does not use as opt-in stops, in endpoint order', () => {
    const plan = planModelSwitch('lowram', healthWith(['text', 'd1omni', 'audio']))
    expect(plan.toStart).toEqual([])
    expect(plan.spareLoaded).toEqual(['d1omni', 'audio'])
  })

  it('reports both starts and spares when the switch changes the roster', () => {
    const plan = planModelSwitch('omni', healthWith(['audio', 'text']))
    expect(plan.toStart).toEqual(['omni', 'd1omni'])
    expect(plan.spareLoaded).toEqual(['audio'])
  })

  it('treats unknown health (null) as everything down: start the roster, stop nothing', () => {
    const plan = planModelSwitch('worker-d1', null)
    expect(plan.toStart).toEqual(['text', 'd1omni'])
    expect(plan.spareLoaded).toEqual([])
  })
})
