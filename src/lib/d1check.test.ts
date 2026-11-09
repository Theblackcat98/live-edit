import { describe, expect, it } from 'vitest'
import type { D1Answer, ExecutionDiff, WorkerCall } from '../types'
import { NOTE_PATH } from '../data/note'
import {
  D1_CHECK_POLICY,
  buildD1CheckState,
  renderCheckDiff,
  runD1Check,
  type D1CheckInput,
  type D1DecideFn,
} from './d1check'
import { renderToolCallXml } from './worker'

const NOTE = ['# Launch notes', '', 'Supply chain delays.'].join('\n')

function makeCall(): WorkerCall {
  const params = {
    file_path: NOTE_PATH,
    start_line: '3',
    end_line: '3',
    old_text_anchor: 'Supply chain delays.',
    new_text: 'Supply chain delays are resolved.',
  }
  return {
    name: 'edit_text',
    params,
    thought: 'test call',
    xml: renderToolCallXml('edit_text', params),
    rawTokens: 12,
    promptHints: [],
    toolSchemasInjected: 0,
    noteView: '',
  }
}

const DIFF: ExecutionDiff = {
  startLine: 3,
  before: ['Supply chain delays.'],
  after: ['Supply chain delays are resolved.'],
  added: 1,
  removed: 1,
}

function input(): D1CheckInput {
  return {
    directive: { task: 'edit', instruction: 'Update the supply chain risk line to say it is resolved.' },
    command: 'mark the supply chain risk resolved',
    call: makeCall(),
    diff: DIFF,
    note: NOTE,
  }
}

function decideWith(answers: Record<string, D1Answer>): D1DecideFn {
  return async () => ({ answers, ms: 42, usage: { promptTokens: 0, outputTokens: 0 } })
}

describe('buildD1CheckState', () => {
  it('assembles the calibrated packet: directive JSON, verbatim command, call JSON, diff', () => {
    const state = buildD1CheckState(input())
    expect(state).toContain('"task": "edit"')
    expect(state).toContain('User command (verbatim): "mark the supply chain risk resolved"')
    expect(state).toContain('"name": "edit_text"')
    expect(state).toContain('@@ lines 3-3 replaced @@')
    expect(state).toContain('- Supply chain delays.')
    expect(state).toContain('+ Supply chain delays are resolved.')
    expect(state).not.toContain('video frame is attached')
  })

  it('mentions the attached frame only when one is supplied', () => {
    const state = buildD1CheckState({ ...input(), imageDataUrl: 'data:image/png;base64,x' })
    expect(state).toContain('The current video frame is attached.')
  })
})

describe('renderCheckDiff', () => {
  it('renders inserts and removals with spike-style headers', () => {
    expect(renderCheckDiff({ startLine: 5, before: [], after: ['New line.'], added: 1, removed: 0 }, 9))
      .toContain('@@ insert at line 5 @@')
    const removal = renderCheckDiff(
      { startLine: 2, before: ['a', 'b'], after: [], added: 0, removed: 2 },
      9,
    )
    expect(removal).toContain('@@ lines 2-3 removed (2 of 9 lines) @@')
  })
})

describe('runD1Check verdict policy (E3 calibration)', () => {
  it('approves iff noul ≥ threshold and safety = safe', async () => {
    const result = await runD1Check(
      input(),
      decideWith({
        does_call_match_directive: { type: 'noul', noul: 0.84 },
        destructive_safety: { type: 'choice', choice: 'safe' },
      }),
    )
    expect(result.verdict).toBe('approved')
    expect(result.noul).toBe(0.84)
    expect(result.ms).toBe(42)
  })

  it('disapproves a sub-threshold noul and names the failing question', async () => {
    const result = await runD1Check(
      input(),
      decideWith({
        does_call_match_directive: { type: 'noul', noul: D1_CHECK_POLICY.noulThreshold - 0.01 },
        destructive_safety: { type: 'choice', choice: 'safe' },
      }),
    )
    expect(result.verdict).toBe('disapproved')
    expect(result.failingQuestion).toBe('does_call_match_directive')
  })

  it('never approves a destructive call, however high the noul', async () => {
    const result = await runD1Check(
      input(),
      decideWith({
        does_call_match_directive: { type: 'noul', noul: 0.99 },
        destructive_safety: { type: 'choice', choice: 'unintended_data_loss' },
      }),
    )
    expect(result.verdict).toBe('disapproved')
    expect(result.failingQuestion).toBe('destructive_safety')
    expect(result.destructiveSafety).toBe('unintended_data_loss')
  })

  it('maps bridge failure to unavailable — never to approval or rejection', async () => {
    const result = await runD1Check(input(), async () => {
      throw new Error('connect ECONNREFUSED')
    })
    expect(result.verdict).toBe('unavailable')
    expect(result.noul).toBeNull()
  })

  it('maps malformed answers to unavailable', async () => {
    const missing = await runD1Check(input(), decideWith({}))
    expect(missing.verdict).toBe('unavailable')
    const wrongType = await runD1Check(
      input(),
      decideWith({
        does_call_match_directive: { type: 'score', score: 0.9 },
        destructive_safety: { type: 'choice', choice: 'safe' },
      }),
    )
    expect(wrongType.verdict).toBe('unavailable')
    const badChoice = await runD1Check(
      input(),
      decideWith({
        does_call_match_directive: { type: 'noul', noul: 0.9 },
        destructive_safety: { type: 'choice', choice: 'mostly_safe' },
      }),
    )
    expect(badChoice.verdict).toBe('unavailable')
  })
})
