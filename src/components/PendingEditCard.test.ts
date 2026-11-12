import { describe, expect, it } from 'vitest'
import type { PendingEdit } from '../types'
import {
  APPLY_LABEL,
  DISCARD_LABEL,
  askedLine,
  busyReason,
  defaultCollapsed,
  diffSummary,
  reasonLine,
  scoreSummary,
  statusExplanation,
  statusTitle,
  verdictChip,
} from './PendingEditCard'

/**
 * PendingEditCard's pure presentational helpers. The repo's vitest harness
 * runs in a node environment with no component-testing dependencies, so the
 * render itself is verified by the Phase-5 wiring battery (QA 31–34); here we
 * pin the user-facing copy and formatting contracts the render is built from.
 */

function makeEdit(overrides: Partial<PendingEdit> = {}): PendingEdit {
  return {
    id: 'pe-1',
    createdAt: 1_700_000_000_000,
    directive: {
      task: 'edit',
      instruction: 'Update the Q3 revenue row to $1.45M Final.',
      target: {
        description: 'the Q3 revenue row in the Quarterly Review table',
        heading: 'Quarterly Review',
      },
      verbatim: null,
      constraints: [],
    },
    call: {
      name: 'edit_text',
      params: {
        start_line: '12',
        end_line: '12',
        old_text_anchor: '| Q3 | $1.2M |',
        new_text: '| Q3 | $1.45M Final |',
      },
      thought: 'swap the Q3 value for the corrected final figure',
      xml: '<tool name="edit_text">…</tool>',
      rawTokens: 42,
      promptHints: [],
      toolSchemasInjected: 4,
      noteView: '',
    },
    diff: {
      startLine: 12,
      before: ['| Q3 | $1.2M |'],
      after: ['| Q3 | $1.45M Final |'],
      added: 1,
      removed: 1,
    },
    noteHash: 'h-1',
    d1: { verdict: 'disapproved', noul: 0.31, destructiveSafety: 'safe' },
    status: 'pending',
    ...overrides,
  }
}

describe('verdict chip (design.md §7/§9)', () => {
  it('labels a real disapproval as red — d1 judged and said no', () => {
    expect(verdictChip('disapproved')).toEqual({
      label: 'Disapproved by d1',
      tone: 'red',
    })
  })

  it('labels an unavailable d1 as orange — the decision is explicitly the user\u2019s', () => {
    expect(verdictChip('unavailable')).toEqual({
      label: 'd1 unavailable — your call',
      tone: 'orange',
    })
  })

  it('labels a §8 blast-radius hold as orange — d1 approved, the harness held it', () => {
    expect(verdictChip('approved')).toEqual({
      label: 'd1 approved — held by the §8 blast-radius rule',
      tone: 'orange',
    })
  })

  it('reads straight off a §9 pending edit\u2019s d1 record', () => {
    expect(verdictChip(makeEdit().d1.verdict).tone).toBe('red')
  })
})

describe('score summary (runtime honesty — never invent a number)', () => {
  it('shows both scores when d1 measured them', () => {
    expect(scoreSummary({ verdict: 'disapproved', noul: 0.31, destructiveSafety: 'safe' })).toBe(
      'match 0.31 · safety safe',
    )
  })

  it('names an unintended-data-loss safety answer in full', () => {
    expect(
      scoreSummary({
        verdict: 'disapproved',
        noul: 0.12,
        destructiveSafety: 'unintended_data_loss',
      }),
    ).toBe('match 0.12 · safety unintended data loss')
  })

  it('rounds measured scores to two decimals', () => {
    expect(
      scoreSummary({ verdict: 'disapproved', noul: 0.876, destructiveSafety: 'safe' }),
    ).toBe('match 0.88 · safety safe')
  })

  it('renders only the value that was really reported', () => {
    expect(
      scoreSummary({ verdict: 'unavailable', noul: null, destructiveSafety: 'safe' }),
    ).toBe('safety safe')
    expect(
      scoreSummary({ verdict: 'unavailable', noul: 0.42, destructiveSafety: null }),
    ).toBe('match 0.42')
  })

  it('shows nothing when nothing was measured — silence is not filled in', () => {
    expect(scoreSummary({ verdict: 'unavailable', noul: null, destructiveSafety: null })).toBeNull()
  })
})

describe('the one line of "what was asked" (design.md §9)', () => {
  it('passes a short instruction through, whitespace-normalized', () => {
    expect(askedLine('Update the Q3 revenue row to $1.45M Final.')).toBe(
      'Update the Q3 revenue row to $1.45M Final.',
    )
    expect(askedLine('  make   it   shorter  ')).toBe('make it shorter')
  })

  it('truncates a long brief to one line with an ellipsis', () => {
    const long = 'Write a README template document to begin the note: title it README and give it the standard sections — overview, getting started, usage, contributing, license.'
    const line = askedLine(long)
    expect(line.length).toBe(90)
    expect(line.endsWith('…')).toBe(true)
    expect(line.startsWith('Write a README template document')).toBe(true)
  })
})

describe('diff summary line', () => {
  it('shows a single line number for a one-line change', () => {
    expect(diffSummary(makeEdit().diff)).toBe('L12 · +1 / −1')
  })

  it('spans the touched range for a multi-line change', () => {
    expect(
      diffSummary({
        startLine: 10,
        before: ['a', 'b'],
        after: ['x', 'y', 'z'],
        added: 3,
        removed: 2,
      }),
    ).toBe('L10–12 · +3 / −2')
  })

  it('covers a pure insertion and a pure removal', () => {
    expect(
      diffSummary({ startLine: 5, before: [], after: ['n1', 'n2', 'n3'], added: 3, removed: 0 }),
    ).toBe('L5–7 · +3 / −0')
    expect(
      diffSummary({ startLine: 5, before: ['gone1', 'gone2'], after: [], added: 0, removed: 2 }),
    ).toBe('L5–6 · +0 / −2')
  })
})

describe('busy reason (§9.4 — no adjudication during a worker run)', () => {
  it('gives the reason while a run is active', () => {
    const reason = busyReason(true)
    expect(reason).not.toBeNull()
    expect(reason).toMatch(/turn is running/)
  })

  it('gives no reason when the card is actionable', () => {
    expect(busyReason(false)).toBeNull()
  })
})

describe('status title per card state', () => {
  it('marks the live decision and the resolved states', () => {
    expect(statusTitle('pending')).toBe('Pending edit — your call')
    expect(statusTitle('applied')).toBe('Pending edit — applied')
    expect(statusTitle('discarded')).toBe('Pending edit — discarded')
    expect(statusTitle('stale')).toBe('Pending edit — stale')
  })
})

describe('collapse policy — live decisions open, resolutions close', () => {
  it('a pending edit renders expanded for adjudication', () => {
    expect(defaultCollapsed('pending')).toBe(false)
  })

  it('resolved cards collapse to one summary row by default', () => {
    expect(defaultCollapsed('applied')).toBe(true)
    expect(defaultCollapsed('discarded')).toBe(true)
    expect(defaultCollapsed('stale')).toBe(true)
  })
})

describe('reason line — human sentence over the machine string', () => {
  it('humanizes a target_support disapproval (the failing question travels)', () => {
    expect(
      reasonLine({
        verdict: 'disapproved',
        noul: 0.63,
        destructiveSafety: 'safe',
        reason: 'disapproved: target_support target_support = unsupported',
      }),
    ).toBe(
      'The note does not contain what the edit targets — a missing heading, absent lines, or an anchor with nothing to attach to.',
    )
  })

  it('passes a hand-written hold reason through verbatim (blast-radius, low-RAM)', () => {
    const reason = 'Removal exceeds the blast-radius limit. Approving executes the removal with the limit waived — you decide.'
    expect(reasonLine({ verdict: 'unavailable', noul: null, destructiveSafety: null, reason })).toBe(reason)
  })

  it('falls back to the recorded reason when the shape is unrecognized', () => {
    expect(reasonLine({ verdict: 'disapproved', noul: null, destructiveSafety: null, reason: 'new shape' })).toBe(
      'new shape',
    )
  })

  it('shows nothing when d1 recorded no reason', () => {
    expect(reasonLine({ verdict: 'disapproved', noul: null, destructiveSafety: null })).toBeNull()
  })
})

describe('status explanation (design.md §8/§9)', () => {
  it('a pending card carries no resolution note', () => {
    expect(statusExplanation('pending')).toBeNull()
  })

  it('stale explains the drift and writes nothing off', () => {
    const note = statusExplanation('stale')
    expect(note).toContain('changed')
    expect(note).toContain('Nothing was written')
    // A hard-gate failure is never shown as a ✓ / ✗ choice (design.md §8).
    expect(note).not.toContain('✓')
    expect(note).not.toContain('✗')
  })

  it('applied and discarded state what happened honestly', () => {
    expect(statusExplanation('applied')).toMatch(/Applied/)
    expect(statusExplanation('applied')).toMatch(/snapshot/)
    expect(statusExplanation('discarded')).toMatch(/Discarded/)
    expect(statusExplanation('discarded')).toMatch(/rejected-traces/)
  })
})

describe('adjudication control labels (aria contract)', () => {
  it('the ✓ / ✗ buttons announce exactly what they do', () => {
    expect(APPLY_LABEL).toBe('Apply proposed edit')
    expect(DISCARD_LABEL).toBe('Discard proposed edit')
  })
})

describe('verdict chip names what actually held the edit', () => {
  it('does not blame d1 in a mode that has no d1', () => {
    expect(verdictChip('unavailable', 'no-decision-model').label).toMatch(/No safety check in this mode/)
  })
  it('does not blame d1 for a removal-limit hold the gates raised', () => {
    expect(verdictChip('unavailable', 'blast-radius').label).toMatch(/removal limit/)
  })
  it('keeps the d1 wording for a real d1 hold', () => {
    expect(verdictChip('unavailable', 'd1').label).toMatch(/d1 unavailable/)
  })
})
