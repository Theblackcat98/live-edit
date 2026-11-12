import { describe, expect, it } from 'vitest'
import {
  D1_FAILURE_SENTENCES,
  D1_QUESTION_PACKET_ORDER,
  humanD1Reason,
} from './d1reason'

/**
 * The human copy contract for held edits (design.md §7/§9): every failing
 * question has a sentence, detection recovers the failing question from the
 * machine reason when the typed field is absent (persisted pendings), and
 * hand-written hold reasons pass through verbatim.
 */

describe('every question has a sentence (packet order preserved)', () => {
  it('covers exactly the five typed questions', () => {
    expect(Object.keys(D1_FAILURE_SENTENCES).sort()).toEqual([...D1_QUESTION_PACKET_ORDER].sort())
  })
})

describe('disapproved — the failing question names the reason', () => {
  it('uses the typed failing question when present', () => {
    expect(
      humanD1Reason({
        verdict: 'disapproved',
        failingQuestion: 'target_support',
        reason: 'disapproved: target_support target_support = unsupported',
      }),
    ).toBe(D1_FAILURE_SENTENCES.target_support)
  })

  it('recovers the failing question from the machine reason in packet order', () => {
    expect(
      humanD1Reason({
        verdict: 'disapproved',
        reason: 'disapproved: target_support target_support = unsupported',
      }),
    ).toBe(D1_FAILURE_SENTENCES.target_support)
  })

  it('prefers the first failing question when several are named', () => {
    expect(
      humanD1Reason({
        verdict: 'disapproved',
        reason:
          'disapproved: does_call_match_directive noul 0.31 < threshold 0.5; target_support = unsupported',
      }),
    ).toBe(D1_FAILURE_SENTENCES.does_call_match_directive)
  })

  it('returns null for an unrecognised reason — the caller keeps its fallback', () => {
    expect(humanD1Reason({ verdict: 'disapproved', reason: 'something new' })).toBeNull()
  })
})

describe('unavailable — machine failures get a generic line, hand-written holds pass through', () => {
  it('a bridge error becomes the human line', () => {
    expect(
      humanD1Reason({ verdict: 'unavailable', reason: 'd1 bridge error: fetch failed' }),
    ).toBe('The safety model could not be consulted, so the decision is yours.')
  })

  it('an unusable answer becomes the human line', () => {
    expect(
      humanD1Reason({ verdict: 'unavailable', reason: 'd1 answer unusable: target_support choice missing' }),
    ).toBe('The safety model could not be consulted, so the decision is yours.')
  })

  it('the §8 blast-radius hold reason is already human — verbatim', () => {
    const reason = 'Removal exceeds the blast-radius limit. Approving executes the removal with the limit waived — you decide.'
    expect(humanD1Reason({ verdict: 'unavailable', reason })).toBe(reason)
  })

  it('the low-RAM hold reason is already human — verbatim', () => {
    const reason = 'Low-RAM mode runs no decision model (d1), so no edit executes silently in this mode.'
    expect(humanD1Reason({ verdict: 'unavailable', reason })).toBe(reason)
  })
})

describe('approved — reachable on a card only via the blast-radius hold', () => {
  it('says d1 approved and names the silent-size rule', () => {
    const line = humanD1Reason({
      verdict: 'approved',
      reason: 'approved: does_call_match_directive noul 0.9 ≥ 0.5, …',
    })
    expect(line).toContain('d1 approved')
    expect(line).toContain('never runs silently')
  })
})
