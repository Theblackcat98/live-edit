import { describe, expect, it, vi } from 'vitest'
import type { D1Answer } from '../types'
import {
  ROUTE_AMBIGUOUS,
  ROUTE_CONFIDENCE_MIN,
  ROUTE_CONVERSATIONAL,
  buildRouteState,
  runD1Route,
} from './d1route'
import type { D1DecideFn } from './d1check'

function routeDecide(intent: string, confidence: number | null): D1DecideFn {
  return vi.fn(async () => ({
    answers: {
      turn_intent: { type: 'choice', choice: intent },
      ...(confidence === null
        ? {}
        : { intent_confidence: { type: 'noul', noul: confidence } }),
    } as Record<string, D1Answer>,
    ms: 10,
    usage: { promptTokens: 0, outputTokens: 0 },
  }))
}

const BASE = { command: 'add a bullet about Q4', audioReply: 'On it.', note: '# Note\n## Q3\n' }

describe('buildRouteState', () => {
  it('carries the command, reply, outline, and continuity', () => {
    const state = buildRouteState({ ...BASE, lastRun: null })
    expect(state).toContain(JSON.stringify(BASE.command))
    expect(state).toContain(JSON.stringify(BASE.audioReply))
    expect(state).toContain('No edits have been committed')
    const withRun = buildRouteState({ ...BASE, lastRun: { command: 'x', status: 'verified' } })
    expect(withRun).toContain('Last completed run')
  })
})

describe('runD1Route', () => {
  it('routes confident edit intents to the worker', async () => {
    for (const task of ['create', 'insert', 'edit', 'remove']) {
      const result = await runD1Route({ ...BASE, lastRun: null, d1Decide: routeDecide(task, 0.9) })
      expect(result.routesToWorker).toBe(true)
      expect(result.intent).toBe(task)
      expect(typeof result.ms).toBe('number')
    }
  })

  it('stays conversational on chat intent', async () => {
    const result = await runD1Route({
      ...BASE,
      command: 'what does the note say',
      lastRun: null,
      d1Decide: routeDecide(ROUTE_CONVERSATIONAL, 0.9),
    })
    expect(result.routesToWorker).toBe(false)
    expect(result.intent).toBe(ROUTE_CONVERSATIONAL)
  })

  it('never routes ambiguity, even at full confidence', async () => {
    const result = await runD1Route({ ...BASE, lastRun: null, d1Decide: routeDecide(ROUTE_AMBIGUOUS, 1) })
    expect(result.routesToWorker).toBe(false)
    expect(result.intent).toBe(ROUTE_AMBIGUOUS)
  })

  it(`holds sub-threshold confidence (${ROUTE_CONFIDENCE_MIN}) to chat`, async () => {
    const result = await runD1Route({ ...BASE, lastRun: null, d1Decide: routeDecide('edit', 0.2) })
    expect(result.routesToWorker).toBe(false)
    expect(result.confidence).toBe(0.2)
  })

  it('fails closed to chat when d1 throws', async () => {
    const d1Decide = vi.fn(async () => {
      throw new Error('d1 down')
    })
    const result = await runD1Route({ ...BASE, lastRun: null, d1Decide })
    expect(result.routesToWorker).toBe(false)
    expect(result.intent).toBe(ROUTE_CONVERSATIONAL)
  })

  it('fails closed to chat when confidence is missing', async () => {
    const result = await runD1Route({ ...BASE, lastRun: null, d1Decide: routeDecide('edit', null) })
    expect(result.routesToWorker).toBe(false)
    expect(result.confidence).toBeNull()
  })

  it('fails closed to chat on an unknown intent choice', async () => {
    const result = await runD1Route({ ...BASE, lastRun: null, d1Decide: routeDecide('dance', 0.9) })
    expect(result.routesToWorker).toBe(false)
    expect(result.intent).toBe(ROUTE_CONVERSATIONAL)
  })
})
