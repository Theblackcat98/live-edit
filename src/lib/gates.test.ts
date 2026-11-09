import { describe, expect, it } from 'vitest'
import type { SpanTarget, WorkerCall } from '../types'
import { INITIAL_NOTE } from '../data/note'
import { lineRangeExcerpt, splitLines } from './doc'
import { checkAnchor, checkBlastRadius, checkBounds, checkSchema, runHardGates } from './gates'
import { executeTool } from './tools'
import { renderToolCallXml } from './worker'

/** splitLines count of the seed note (its trailing newline yields a final empty entry). */
const TOTAL_LINES = splitLines(INITIAL_NOTE).length

function makeCall(name: WorkerCall['name'], params: Record<string, string>): WorkerCall {
  return {
    name,
    params,
    thought: 'test call',
    xml: renderToolCallXml(name, params),
    rawTokens: 12,
    promptHints: [],
    toolSchemasInjected: 0,
    noteView: '',
  }
}

function spanAt(note: string, startLine: number, endLine: number): SpanTarget {
  return {
    startLine,
    endLine,
    excerpt: lineRangeExcerpt(note, startLine, endLine),
    confidence: 0.95,
    reason: 'test span',
  }
}

function excerptOf(note: string, start: number, end: number): string {
  return splitLines(note)
    .slice(start - 1, end)
    .join('\n')
}

/** A 13-line note: the removal cap is max(9, floor(13/2)) = 9 lines. */
const NOTE_13 = [
  '# Small note',
  '',
  'First body line.',
  'Second body line.',
  'Third body line.',
  'Fourth body line.',
  'Fifth body line.',
  'Sixth body line.',
  'Seventh body line.',
  'Eighth body line.',
  'Ninth body line.',
  'Tenth body line.',
  '',
].join('\n')

// --- schema gate ----------------------------------------------------------------

describe('checkSchema', () => {
  it('passes a known tool with every required parameter present and typed', () => {
    const call = makeCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '17',
      end_line: '17',
      old_text_anchor: '| Q3 | $1.2M | Pending |',
      new_text: '| Q3 | $1.45M | Final |',
    })
    const results = checkSchema(call)
    expect(results).toEqual([{ gate: 'schema', pass: true, detail: 'edit_text parameters are valid.' }])
  })

  it('fails an unknown tool and reports nothing else to check', () => {
    const call = { ...makeCall('remove_text', {}), name: 'drop_table' as WorkerCall['name'] }
    expect(checkSchema(call)).toEqual([
      { gate: 'schema', pass: false, detail: 'Unknown tool: drop_table.' },
    ])
  })

  it('fails each missing required parameter by name', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '25',
    })
    expect(checkSchema(call)).toEqual([
      { gate: 'schema', pass: false, detail: 'Missing required parameter: end_line.' },
      { gate: 'schema', pass: false, detail: 'Missing required parameter: target_excerpt.' },
    ])
  })

  it('fails a required parameter that is present but empty', () => {
    const call = makeCall('add_text', {
      file_path: 'notes/quarterly-review.md',
      position: 'append',
      content: '   ',
    })
    expect(checkSchema(call)).toEqual([
      { gate: 'schema', pass: false, detail: 'Missing required parameter: content.' },
    ])
  })

  it('fails a range parameter that is not an integer — the engine guard, mirrored', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '2.5',
      end_line: '9',
      target_excerpt: 'whatever',
    })
    expect(checkSchema(call)).toEqual([
      { gate: 'schema', pass: false, detail: 'Parameter start_line must be an integer.' },
    ])
  })

  it('does not demand optional parameters', () => {
    const call = makeCall('add_text', {
      file_path: 'notes/quarterly-review.md',
      position: 'append',
      content: 'New final line.',
    })
    expect(checkSchema(call)[0].pass).toBe(true)
  })
})

// --- bounds gate (edges) ---------------------------------------------------------

describe('checkBounds', () => {
  it('passes the first line of the note', () => {
    const call = makeCall('remove_text', { start_line: '1', end_line: '1' })
    expect(checkBounds(INITIAL_NOTE, call)).toEqual({
      gate: 'range_in_bounds',
      pass: true,
      detail: `Lines 1–1 exist (${TOTAL_LINES} total).`,
    })
  })

  it('passes the last line of the note', () => {
    const last = splitLines(INITIAL_NOTE).filter((line) => line.trim() !== '').length
    const call = makeCall('remove_text', { start_line: String(last), end_line: String(last) })
    expect(checkBounds(INITIAL_NOTE, call)?.pass).toBe(true)
  })

  it('fails when end < start', () => {
    const call = makeCall('edit_text', { start_line: '17', end_line: '16' })
    expect(checkBounds(INITIAL_NOTE, call)).toEqual({
      gate: 'range_in_bounds',
      pass: false,
      detail: 'Proposed range is outside the note.',
    })
  })

  it('fails when end is past the last line', () => {
    const call = makeCall('edit_text', { start_line: '17', end_line: String(TOTAL_LINES + 5) })
    expect(checkBounds(INITIAL_NOTE, call)?.pass).toBe(false)
  })

  it('fails a zero or negative start', () => {
    expect(checkBounds(INITIAL_NOTE, makeCall('edit_text', { start_line: '0', end_line: '3' }))?.pass).toBe(false)
  })

  it('fails non-numeric range values', () => {
    expect(checkBounds(INITIAL_NOTE, makeCall('edit_text', { start_line: 'abc', end_line: '3' }))?.pass).toBe(false)
  })

  it('does not apply to tools without a range', () => {
    expect(checkBounds(INITIAL_NOTE, makeCall('add_text', { content: 'x' }))).toBeNull()
  })
})

// --- anchor gate (span-override semantics, audit TD-01) --------------------------

describe('checkAnchor', () => {
  const anchored = makeCall('edit_text', {
    file_path: 'notes/quarterly-review.md',
    start_line: '17',
    end_line: '17',
    old_text_anchor: '| Q3 | $1.2M | Pending |',
    new_text: '| Q3 | $1.45M | Final |',
  })

  it('passes when the anchor matches the note lines at the stated range', () => {
    expect(checkAnchor(INITIAL_NOTE, anchored)).toEqual({
      gate: 'anchor_exact',
      pass: true,
      detail: 'old_text_anchor matches the current lines exactly.',
    })
  })

  it('compares whitespace-normalized, so indentation drift does not fail it', () => {
    const spaced = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '25',
      end_line: '25',
      target_excerpt: '-   Redis   cache   migration   was   postponed   to   Q4.',
    })
    expect(checkAnchor(INITIAL_NOTE, spaced)?.pass).toBe(true)
  })

  it('fails a drifted anchor with the critic’s exact detail string', () => {
    const drifted = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '25',
      end_line: '25',
      target_excerpt: 'text that is not there',
    })
    expect(checkAnchor(INITIAL_NOTE, drifted)).toEqual({
      gate: 'anchor_exact',
      pass: false,
      detail: 'Anchor drifted from the grounded span.',
    })
  })

  it('span override: an anchor equal to the span excerpt passes even when the call range disagrees with the note', () => {
    // The supervisor's span covers the whole Risks block; the call names a
    // narrower range whose own text is NOT the anchor. Today's critic accepts
    // this because the anchor is validated against the SUPERVISOR'S span.
    const span = spanAt(INITIAL_NOTE, 28, 32)
    const narrow = makeCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '30',
      end_line: '30',
      old_text_anchor: span.excerpt,
      new_text: excerptOf(INITIAL_NOTE, 28, 32),
    })
    expect(checkAnchor(INITIAL_NOTE, narrow, span.excerpt)).toEqual({
      gate: 'anchor_exact',
      pass: true,
      detail: 'old_text_anchor matches the grounded span exactly.',
    })
    // Without the override, the same call fails against the note's own line.
    expect(checkAnchor(INITIAL_NOTE, narrow)?.pass).toBe(false)
  })

  it('does not apply to tools without a range anchor', () => {
    expect(checkAnchor(INITIAL_NOTE, makeCall('add_text', { content: 'x' }))).toBeNull()
  })
})

// --- blast-radius gate (audit TD-44; engine twin lives in tools.ts) ---------------

describe('checkBlastRadius', () => {
  it('passes a surgical single-line removal', () => {
    const call = makeCall('remove_text', { start_line: '25', end_line: '25' })
    expect(checkBlastRadius(INITIAL_NOTE, call)).toEqual({
      gate: 'destructive_safety',
      pass: true,
      detail: '1 line removed; below blast-radius limit.',
    })
  })

  it('passes a replacement that retains the target', () => {
    const call = makeCall('edit_text', {
      start_line: '17',
      end_line: '17',
      old_text_anchor: '| Q3 | $1.2M | Pending |',
      new_text: '| Q3 | $1.45M | Final |',
    })
    expect(checkBlastRadius(INITIAL_NOTE, call)?.pass).toBe(true)
  })

  it('fails a removal past the cap: half the note or more', () => {
    // 12 of 13 lines: cap is max(9, floor(13/2)) = 9, removed 12 ≥ 9.
    const call = makeCall('remove_text', { start_line: '1', end_line: '12' })
    expect(checkBlastRadius(NOTE_13, call)).toEqual({
      gate: 'destructive_safety',
      pass: false,
      detail: 'Removal exceeds the blast-radius limit.',
    })
  })

  it('fails a replacement that collapses the target at any size — no 90-character floor', () => {
    const call = makeCall('edit_text', {
      start_line: '3',
      end_line: '3',
      old_text_anchor: excerptOf(INITIAL_NOTE, 3, 3),
      new_text: 'tiny',
    })
    const result = checkBlastRadius(INITIAL_NOTE, call)
    expect(result?.pass).toBe(false)
    expect(result?.gate).toBe('blast_radius')
    expect(result?.detail).toBe('Replacement collapses the grounded target. Ask for a narrower target.')
  })

  it('does not apply to tools that cannot delete', () => {
    expect(checkBlastRadius(INITIAL_NOTE, makeCall('add_text', { content: 'x' }))).toBeNull()
  })
})

// --- composition + the engine twin (QA 12c evidence, plan §5.3) -------------------

describe('runHardGates', () => {
  it('passes a clean grounded call with no failures', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '25',
      end_line: '25',
      target_excerpt: '- Redis cache migration was postponed to Q4.',
    })
    const result = runHardGates(INITIAL_NOTE, call, spanAt(INITIAL_NOTE, 25, 25))
    expect(result).toEqual({ pass: true, failures: [] })
  })

  it('QA 12c (edit flavour): "Replace the Risks section with tiny" fails the blast-radius gate', () => {
    const call = makeCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '28',
      end_line: '32',
      old_text_anchor: excerptOf(INITIAL_NOTE, 28, 32),
      new_text: 'tiny',
    })
    const result = runHardGates(INITIAL_NOTE, call)
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual([
      { gate: 'blast_radius', detail: 'Replacement collapses the grounded target. Ask for a narrower target.' },
    ])
    // The engine refuses the same call directly — the pre-check cannot be
    // bypassed by calling executeTool (P1 step 3).
    const execution = executeTool(INITIAL_NOTE, call)
    expect(execution.ok).toBe(false)
    expect(execution.message).toContain('collapses the target')
    expect(execution.note).toBe(INITIAL_NOTE)
  })

  it('QA 12c (remove flavour): an over-broad removal fails the gate and the engine refuses it directly', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '22',
      end_line: '42',
      target_excerpt: excerptOf(INITIAL_NOTE, 22, 42),
    })
    const result = runHardGates(INITIAL_NOTE, call)
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual([
      { gate: 'destructive_safety', detail: 'Removal exceeds the blast-radius limit.' },
    ])
    const execution = executeTool(INITIAL_NOTE, call)
    expect(execution.ok).toBe(false)
    expect(execution.message).toContain('blast-radius')
    expect(execution.note).toBe(INITIAL_NOTE)
  })

  it('forwards the span as the anchor source (TD-01): range-disagreeing anchor passes with the span, fails without', () => {
    const span = spanAt(INITIAL_NOTE, 28, 32)
    const narrow = makeCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '30',
      end_line: '30',
      old_text_anchor: span.excerpt,
      new_text: excerptOf(INITIAL_NOTE, 28, 32),
    })
    expect(runHardGates(INITIAL_NOTE, narrow, span).pass).toBe(true)
    expect(runHardGates(INITIAL_NOTE, narrow).failures).toEqual([
      { gate: 'anchor_exact', detail: 'Anchor drifted from the grounded span.' },
    ])
  })

  it('an out-of-bounds range short-circuits anchor and blast radius', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '1',
      end_line: String(TOTAL_LINES + 10),
      target_excerpt: 'whatever',
    })
    expect(runHardGates(INITIAL_NOTE, call).failures).toEqual([
      { gate: 'range_in_bounds', detail: 'Proposed range is outside the note.' },
    ])
  })

  it('an unknown tool reports only the schema failure', () => {
    const call = { ...makeCall('remove_text', {}), name: 'format_disk' as WorkerCall['name'] }
    expect(runHardGates(INITIAL_NOTE, call).failures).toEqual([
      { gate: 'schema', detail: 'Unknown tool: format_disk.' },
    ])
  })

  it('missing required parameters report schema failures and skip the range gates', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '25',
    })
    expect(runHardGates(INITIAL_NOTE, call).failures).toEqual([
      { gate: 'schema', detail: 'Missing required parameter: end_line.' },
      { gate: 'schema', detail: 'Missing required parameter: target_excerpt.' },
    ])
  })
})
