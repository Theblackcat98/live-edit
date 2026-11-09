import { beforeEach, describe, expect, it, vi } from 'vitest'

const { d1DecideMock } = vi.hoisted(() => ({ d1DecideMock: vi.fn() }))

// resolveGroundingSpan's d1 branch is exercised through the bridge seam: the
// mock answers the typed span_choice question deterministically.
vi.mock('./bridge', () => ({ d1Decide: d1DecideMock }))

import type { SpanTarget } from '../types'
import { INITIAL_NOTE } from '../data/note'
import { lineRangeExcerpt } from './doc'
import { resolveGroundingSpan, type SupervisorPlan } from './supervisor'

interface D1DecidePayload {
  questions: Record<string, { criteria: Record<string, string> }>
}

/** Answer span_choice with the option whose criteria text satisfies `matches`. */
function answerOption(matches: (text: string) => boolean, p = 0.9): void {
  d1DecideMock.mockImplementation((payload: D1DecidePayload) => {
    const criteria = payload.questions.span_choice?.criteria ?? {}
    const entry = Object.entries(criteria).find(([, text]) => matches(text))
    if (!entry) return Promise.reject(new Error('no matching span option in test mock'))
    return Promise.resolve({
      answers: {
        span_choice: { type: 'choice', choice: entry[0], probabilities: { [entry[0]]: p } },
      },
      ms: 4,
      usage: { promptTokens: 120, outputTokens: 8 },
    })
  })
}

/**
 * Answer span_choice WITHOUT a probability distribution — the server variant
 * audit TD-04 targets: the typed choice arrives, the score does not.
 */
function answerOptionUnreported(matches: (text: string) => boolean): void {
  d1DecideMock.mockImplementation((payload: D1DecidePayload) => {
    const criteria = payload.questions.span_choice?.criteria ?? {}
    const entry = Object.entries(criteria).find(([, text]) => matches(text))
    if (!entry) return Promise.reject(new Error('no matching span option in test mock'))
    return Promise.resolve({
      answers: { span_choice: { type: 'choice', choice: entry[0] } },
      ms: 4,
      usage: { promptTokens: 120, outputTokens: 8 },
    })
  })
}

function spanAt(startLine: number, endLine: number): SpanTarget {
  return {
    startLine,
    endLine,
    excerpt: lineRangeExcerpt(INITIAL_NOTE, startLine, endLine),
    confidence: 0.7,
    reason: 'keyword test span',
  }
}

const QUOTED_PHRASE_EDIT = 'Replace "tracking 12% above plan" with "tracking 14% above plan"'

describe('resolveGroundingSpan: phrase preservation across the d1 re-ground (TD-43)', () => {
  beforeEach(() => {
    d1DecideMock.mockReset()
  })

  it('keeps a quoted-phrase edit surgical when d1 re-grounds a single-line span', async () => {
    answerOption((text) => text.includes('[bullet]') && text.includes('Support volume'))
    const plan: SupervisorPlan = { span: spanAt(31, 31) }
    const resolution = await resolveGroundingSpan(QUOTED_PHRASE_EDIT, INITIAL_NOTE, plan, 'edit_text')
    expect(resolution.source).toBe('d1-span')
    // Only the quoted phrase is swapped; the list marker and the line's own
    // wording survive (a whole-span rewrite would read "2. Tracking 14%
    // above plan.").
    expect(resolution.planPatch?.newText).toBe('2. Support volume is tracking 14% above plan.')
  })

  it('edits one line in place inside a re-grounded multi-line span instead of rewriting it', async () => {
    answerOption((text) => text.includes('[section]') && text.includes('Risks'))
    const plan: SupervisorPlan = { span: spanAt(28, 33) }
    const resolution = await resolveGroundingSpan(QUOTED_PHRASE_EDIT, INITIAL_NOTE, plan, 'edit_text')
    expect(resolution.source).toBe('d1-span')
    const newText = resolution.planPatch?.newText ?? ''
    expect(newText).toContain('2. Support volume is tracking 14% above plan.')
    expect(newText).toContain('1. Enterprise pipeline concentration remains high.')
    expect(newText).toContain('## 4. Risks')
  })

  it('live:false stays on the deterministic fallback without touching d1', async () => {
    const plan: SupervisorPlan = { span: spanAt(17, 17) }
    const resolution = await resolveGroundingSpan(
      'update the Q3 revenue row to $1.45M Final',
      INITIAL_NOTE,
      plan,
      'edit_text',
      { live: false },
    )
    expect(resolution.source).toBe('fallback-keyword')
    expect(resolution.planPatch).toBeUndefined()
    expect(d1DecideMock).not.toHaveBeenCalled()
  })
})

describe('resolveGroundingSpan: unreported choices are non-decisive (TD-04)', () => {
  beforeEach(() => {
    d1DecideMock.mockReset()
  })

  it('an unreported choice cannot overturn a local miss', async () => {
    answerOptionUnreported((text) => text.includes('[bullet]') && text.includes('Redis'))
    // The deterministic search found nothing: no span, target missing.
    const plan: SupervisorPlan = {}
    const resolution = await resolveGroundingSpan(
      'remove the bullet about Redis',
      INITIAL_NOTE,
      plan,
      'remove_text',
    )
    expect(resolution.source).toBe('fallback-keyword')
    expect(resolution.detail).toContain('reported no probability')
    expect(resolution.span).toBeUndefined()
  })

  it('a decisive measured choice still overturns the miss', async () => {
    answerOption((text) => text.includes('[bullet]') && text.includes('Redis'), 0.9)
    const plan: SupervisorPlan = {}
    const resolution = await resolveGroundingSpan(
      'remove the bullet about Redis',
      INITIAL_NOTE,
      plan,
      'remove_text',
    )
    expect(resolution.source).toBe('d1-span')
    expect(resolution.resolvedMiss).toBe(true)
    expect(resolution.p).toBe(0.9)
    expect(resolution.span?.confidence).toBeCloseTo(0.915, 3)
  })

  it('adopts an unreported choice when the local search already grounded a span, with null confidence', async () => {
    // The local search grounded the Redis bullet (L25); d1 picks a different,
    // non-enclosing bullet but reports no probability. The choice adopts —
    // the span carries confidence null (unreported), never an invented number.
    answerOptionUnreported((text) => text.includes('[bullet]') && text.includes('Support volume'))
    const plan: SupervisorPlan = { span: spanAt(25, 25) }
    const resolution = await resolveGroundingSpan(
      'remove the bullet about Support volume',
      INITIAL_NOTE,
      plan,
      'remove_text',
    )
    expect(resolution.source).toBe('d1-span')
    expect(resolution.span?.confidence).toBeNull()
    expect(resolution.span?.reason).toContain('unreported')
    expect(resolution.p).toBeNull()
  })
})
