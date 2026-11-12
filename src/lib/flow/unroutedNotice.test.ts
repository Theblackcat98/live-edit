import { describe, expect, it } from 'vitest'
import { unroutedEditNotice } from './omniFlow'

/**
 * Audio replies before d1 routes and is prompted to acknowledge change
 * requests, so an unrouted edit must always be followed by a notice that
 * nothing changed. A clear conversational verdict needs none.
 */
describe('unroutedEditNotice', () => {
  it('says nothing for a clear conversational turn', () => {
    expect(unroutedEditNotice({ intent: 'conversational', confidence: 0.95 })).toBeNull()
  })

  it('says nothing changed when d1 saw an edit below the confidence threshold', () => {
    const notice = unroutedEditNotice({ intent: 'edit', confidence: 0.42 })
    expect(notice).toMatch(/^Nothing was changed/)
    expect(notice).toMatch(/an edit request but with low confidence \(0\.42, needs 0\.50\)/)
  })

  it('says nothing changed for an ambiguous turn', () => {
    expect(unroutedEditNotice({ intent: 'ambiguous', confidence: 0.8 })).toMatch(/could not tell/)
  })

  it('names the router failure instead of claiming a verdict', () => {
    const notice = unroutedEditNotice({
      intent: 'conversational',
      confidence: null,
      error: 'd1 did not answer: Request timed out after 30s',
    })
    expect(notice).toMatch(/router \(d1\) gave no usable answer \(d1 did not answer: Request timed out after 30s\)/)
  })
})
