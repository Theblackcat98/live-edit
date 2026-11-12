/**
 * Regression tests for trace honesty: what the drawer and rail read must be
 * what the servers reported, never a double count or a dropped field.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ContextUsage, Trace, TurnExchange } from '../types'
import { createTracePublisher, makeTrace, type PipelineDeps } from './flow/turnContext'
import {
  CHOICE_QUESTION_ID,
  CLARITY_QUESTION_ID,
  CONFIDENCE_QUESTION_ID,
  NOUL_QUESTION_ID,
  TARGET_QUESTION_ID,
  runD1Check,
  type D1DecideFn,
} from './d1check'
import { runD1Route } from './d1route'

// finish() schedules the idle-stage reset on window; node has no window.
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined })

function fakeDeps() {
  let usage: ContextUsage = { omni: 0, d1: 0, worker: 0 }
  const deps = {
    setTrace: vi.fn(),
    traceRef: { current: null },
    runsRef: { current: [] as Trace[] },
    setRuns: vi.fn(),
    setStage: vi.fn(),
    setFlowModel: vi.fn(),
    setBusy: vi.fn(),
    busyRef: { current: true },
    idleTimerRef: { current: null },
    setContextUsage: (update: (previous: ContextUsage) => ContextUsage) => {
      usage = update(usage)
    },
  } as unknown as PipelineDeps
  return { deps, usage: () => usage }
}

function exchange(role: 'chat' | 'worker', promptTokens: number, outputTokens: number): TurnExchange {
  return {
    id: `ex-${role}-${promptTokens}`,
    role,
    label: 'primary',
    model: role === 'chat' ? 'LFM3-Audio-2B' : 'LFM3-1.7B',
    url: 'http://127.0.0.1:8086/v1/chat/completions',
    at: 0,
    ms: 10,
    ok: true,
    request: { messages: [], stream: false, temperature: 0, maxTokens: null },
    response: { text: '', reasoning: '', toolCalls: [], promptTokens, outputTokens, finishReason: 'stop' },
  }
}

describe('trace publisher totals and measured usage', () => {
  it('sums every timing bucket exactly once', () => {
    const { deps } = fakeDeps()
    const trace = makeTrace('hi', 'text', 'note')
    // Audio-mode chat turn: Audio's call is chat time, d1's route is route time.
    trace.timings.chat = 900
    trace.timings.route = 200
    createTracePublisher(deps, trace).finish('conversational')
    expect(trace.timings.total).toBe(1100)
  })

  it('takes output tokens from what the servers reported across exchanges', () => {
    const { deps } = fakeDeps()
    const trace = makeTrace('edit', 'text', 'note')
    trace.exchanges = [exchange('chat', 1800, 40), exchange('worker', 2400, 130)]
    createTracePublisher(deps, trace).finish('verified')
    expect(trace.outputTokens).toBe(170)
  })

  it('applies measured prompt sizes to the context budget', () => {
    const { deps, usage } = fakeDeps()
    const trace = makeTrace('edit', 'text', 'note')
    trace.exchanges = [exchange('worker', 2400, 130)]
    createTracePublisher(deps, trace, { omni: 1800, d1: 2600 }).finish('verified')
    expect(usage()).toEqual({ omni: 1800, d1: 2600, worker: 2400 })
  })

  it('leaves the context budget untouched when nothing was measured', () => {
    const { deps, usage } = fakeDeps()
    const trace = makeTrace('hi', 'text', 'note')
    createTracePublisher(deps, trace).finish('failed')
    expect(usage()).toEqual({ omni: 0, d1: 0, worker: 0 })
  })
})

describe('d1 data the server returns is kept', () => {
  const decide: D1DecideFn = async () => ({
    answers: {
      [NOUL_QUESTION_ID]: { type: 'noul', noul: 0.84 },
      [CHOICE_QUESTION_ID]: {
        type: 'choice',
        choice: 'safe',
        probabilities: { safe: 0.97, unintended_data_loss: 0.03 },
      },
      [CLARITY_QUESTION_ID]: { type: 'noul', noul: 0.9 },
      [TARGET_QUESTION_ID]: {
        type: 'choice',
        choice: 'supported',
        probabilities: { supported: 0.88, unsupported: 0.12 },
      },
      [CONFIDENCE_QUESTION_ID]: { type: 'noul', noul: 0.8 },
    },
    ms: 300,
    usage: { promptTokens: 2682, outputTokens: 0 },
  })

  it('carries choice probabilities and prompt tokens on the check result', async () => {
    const check = await runD1Check({ state: 's', d1Decide: decide })
    expect(check.verdict).toBe('approved')
    expect(check.probabilities?.destructiveSafety?.safe).toBe(0.97)
    expect(check.probabilities?.targetSupport?.supported).toBe(0.88)
    expect(check.promptTokens).toBe(2682)
  })

  it('carries prompt tokens on the route result', async () => {
    const route = await runD1Route({
      command: 'hello',
      audioReply: 'hi',
      note: '# Note',
      lastRun: null,
      d1Decide: async () => ({
        answers: {
          turn_intent: { type: 'choice', choice: 'conversational' },
          intent_confidence: { type: 'noul', noul: 0.95 },
        },
        ms: 100,
        usage: { promptTokens: 410, outputTokens: 0 },
      }),
    })
    expect(route.routesToWorker).toBe(false)
    expect(route.promptTokens).toBe(410)
  })
})
