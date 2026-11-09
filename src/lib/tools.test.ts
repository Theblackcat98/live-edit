import { describe, expect, it } from 'vitest'
import type { SpanTarget, WorkerCall } from '../types'
import { INITIAL_NOTE } from '../data/note'
import { lineRangeExcerpt } from './doc'
import { executeTool } from './tools'
import { renderToolCallXml } from './worker'

function makeCall(name: 'edit_text' | 'remove_text', params: Record<string, string>): WorkerCall {
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

function excerptOf(note: string, start: number, end: number): string {
  return note.split('\n').slice(start - 1, end).join('\n')
}

describe('executeTool: engine-level blast radius (TD-44)', () => {
  it('rejects a direct call that deletes 12 of 13 lines', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '1',
      end_line: '12',
      target_excerpt: excerptOf(NOTE_13, 1, 12),
    })
    const result = executeTool(NOTE_13, call)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('blast-radius')
    expect(result.note).toBe(NOTE_13)
  })

  it('names the grounded span in the rejection when one is supplied', () => {
    const span = spanAt(NOTE_13, 1, 12)
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '1',
      end_line: '12',
      target_excerpt: excerptOf(NOTE_13, 1, 12),
    })
    const result = executeTool(NOTE_13, call, span)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('grounded span lines 1–12')
  })

  it('still executes removals under the cap', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '3',
      end_line: '10',
      target_excerpt: excerptOf(NOTE_13, 3, 10),
    })
    const result = executeTool(NOTE_13, call)
    expect(result.ok).toBe(true)
    expect(result.diff?.removed).toBe(8)
  })

  it('holds edit retention at any target size — no 90-character floor', () => {
    const short = makeCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '28',
      end_line: '28',
      old_text_anchor: '## 4. Risks',
      new_text: 'x',
    })
    expect(executeTool(INITIAL_NOTE, short).ok).toBe(false)

    const long = makeCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '3',
      end_line: '3',
      old_text_anchor: excerptOf(INITIAL_NOTE, 3, 3),
      new_text: 'tiny',
    })
    const result = executeTool(INITIAL_NOTE, long)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('characters retained')
  })

  it('executes a same-length row edit with the grounded span passed through', () => {
    const span = spanAt(INITIAL_NOTE, 17, 17)
    const call = makeCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '17',
      end_line: '17',
      old_text_anchor: '| Q3 | $1.2M | Pending |',
      new_text: '| Q3 | $1.45M | Final |',
    })
    const result = executeTool(INITIAL_NOTE, call, span)
    expect(result.ok).toBe(true)
    expect(result.note).toContain('| Q3 | $1.45M | Final |')
    expect(result.diff).toMatchObject({ added: 1, removed: 1 })
  })
})

describe('executeTool: unchanged good paths (regression)', () => {
  it('removes a single grounded bullet', () => {
    const call = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '25',
      end_line: '25',
      target_excerpt: '- Redis cache migration was postponed to Q4.',
    })
    const result = executeTool(INITIAL_NOTE, call, spanAt(INITIAL_NOTE, 25, 25))
    expect(result.ok).toBe(true)
    expect(result.note).not.toContain('Redis')
  })

  it('still enforces the pre-existing anchor and range guards', () => {
    const drifted = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '25',
      end_line: '25',
      target_excerpt: 'text that is not there',
    })
    expect(executeTool(INITIAL_NOTE, drifted).ok).toBe(false)

    const outOfBounds = makeCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '40',
      end_line: '99',
      target_excerpt: 'whatever',
    })
    expect(executeTool(INITIAL_NOTE, outOfBounds).ok).toBe(false)
  })
})
