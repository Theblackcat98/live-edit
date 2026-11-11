import type { ExecutionDiff, ExecutionResult, SpanTarget, WorkerCall } from '../types'
import {
  collapseBlankLines,
  findHeading,
  findSectionEnd,
  normalizeWhitespace,
  splitLines,
} from './doc'

/**
 * Engine-level blast radius, enforced independently of the critic (audit
 * TD-44): a direct executeTool call must not be able to delete most of the
 * note or gut a target, whatever the caller believes.
 */
function removalCapFor(lineCount: number): number {
  return Math.max(9, Math.floor(lineCount * 0.5))
}

const EDIT_RETENTION_RATIO = 0.3

interface NoteBlockResult {
  note: string
  startLine: number
  endLine: number
}

function finalizeNote(lines: string[]): string {
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

function insertUnderHeading(note: string, headingTitle: string, content: string): NoteBlockResult | null {
  const heading = findHeading(note, headingTitle)
  if (!heading) return null
  const lines = splitLines(note)
  const nextHeadingLine = findSectionEnd(note, heading)
  let insertIndex = Math.min(nextHeadingLine - 1, lines.length)
  const headingIndex = heading.line - 1
  while (insertIndex - 1 > headingIndex && lines[insertIndex - 1]?.trim() === '') {
    insertIndex -= 1
  }
  const before = lines.slice(0, insertIndex)
  while (before.length && before[before.length - 1].trim() === '') before.pop()
  const after = lines.slice(insertIndex)
  while (after.length && after[0].trim() === '') after.shift()

  const contentLines = content.trim().split('\n')
  const nextLines = [...before, '', ...contentLines]
  if (after.length) nextLines.push('', ...after)
  const startLine = before.length + 2
  return {
    note: finalizeNote(nextLines),
    startLine,
    endLine: startLine + contentLines.length - 1,
  }
}

function appendContent(note: string, content: string): NoteBlockResult {
  const lines = splitLines(note)
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const contentLines = content.trim().split('\n')
  // An empty note contributes no separator: joining a leading '' with the
  // content leaves a blank first line (battery cases 12b/12d — the bars
  // require the template to start with the heading).
  const nextLines = lines.length ? [...lines, '', ...contentLines, ''] : [...contentLines, '']
  return {
    note: finalizeNote(nextLines),
    startLine: lines.length ? lines.length + 2 : 1,
    endLine: lines.length ? lines.length + 1 + contentLines.length : contentLines.length,
  }
}

function prependContent(note: string, content: string): NoteBlockResult {
  const lines = splitLines(note)
  while (lines.length && lines[0].trim() === '') lines.shift()
  const contentLines = content.trim().split('\n')
  // Same empty-note rule as append: no leading separator when there is no
  // existing content to separate from.
  if (!lines.length) {
    return {
      note: finalizeNote([...contentLines, '']),
      startLine: 1,
      endLine: contentLines.length,
    }
  }
  return {
    note: finalizeNote([...contentLines, '', ...lines]),
    startLine: 1,
    endLine: contentLines.length,
  }
}

 

function insertAfterLine(note: string, anchorLine: number, content: string): NoteBlockResult | null {
  const lines = splitLines(note)
  if (!Number.isInteger(anchorLine) || anchorLine < 1 || anchorLine > lines.length) return null
  const before = lines.slice(0, anchorLine)
  const after = lines.slice(anchorLine)
  if (before.length && before[before.length - 1].trim() !== '') before.push('')
  if (after.length && after[0].trim() !== '') after.unshift('')
  const contentLines = content.trim().split('\n')
  return {
    note: finalizeNote([...before, ...contentLines, ...after]),
    startLine: before.length + 1,
    endLine: before.length + contentLines.length,
  }
}

export function executeTool(
  note: string,
  call: WorkerCall,
  span?: SpanTarget,
  options: { overrideBlastRadius?: boolean } = {},
): ExecutionResult {
  const started = performance.now()
  const finish = (
    result: Omit<ExecutionResult, 'durationMs'>,
  ): ExecutionResult => ({ ...result, durationMs: performance.now() - started })
  const spanNote = span ? ` (grounded span lines ${span.startLine}–${span.endLine})` : ''

  if (call.name === 'edit_text') {
    const start = Number(call.params.start_line)
    const end = Number(call.params.end_line)
    const lines = splitLines(note)
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > lines.length
    ) {
      return finish({ ok: false, message: 'Target range is outside the note.', tool: call.name, note })
    }
    const current = lines.slice(start - 1, end).join('\n')
    if (normalizeWhitespace(current) !== normalizeWhitespace(call.params.old_text_anchor)) {
      return finish({
        ok: false,
        message: 'Anchor check failed: the target text moved before execution.',
        tool: call.name,
        note,
      })
    }
    // Blast radius: a replacement keeping under 30% of the target's length
    // guts it, at any target size — the old 90-character floor let
    // short-target gutting through (audit TD-44).
    const retained = call.params.new_text.trim().length
    if (!options.overrideBlastRadius && retained < current.length * EDIT_RETENTION_RATIO) {
      return finish({
        ok: false,
        message: `Replacement collapses the target: ${retained} of ${current.length} characters retained${spanNote}.`,
        tool: call.name,
        note,
      })
    }
    const replacement = call.params.new_text.replace(/^\n+|\n+$/g, '')
    if (!replacement.trim()) {
      return finish({ ok: false, message: 'Replacement text is empty.', tool: call.name, note })
    }
    if (normalizeWhitespace(replacement) === normalizeWhitespace(current)) {
      return finish({
        ok: true,
        message: 'No change needed — the target already matches the requested text.',
        tool: call.name,
        note,
      })
    }
    const replacementLines = replacement.split('\n')
    const nextLines = [...lines.slice(0, start - 1), ...replacementLines, ...lines.slice(end)]
    const diff: ExecutionDiff = {
      startLine: start,
      before: lines.slice(start - 1, end),
      after: replacementLines,
      added: replacementLines.length,
      removed: end - start + 1,
    }
    return finish({
      ok: true,
      message: `Replaced lines ${start}–${end} with ${replacementLines.length} line${
        replacementLines.length === 1 ? '' : 's'
      }.`,
      tool: call.name,
      note: finalizeNote(nextLines),
      diff,
    })
  }

  if (call.name === 'remove_text') {
    const start = Number(call.params.start_line)
    const end = Number(call.params.end_line)
    const lines = splitLines(note)
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > lines.length
    ) {
      return finish({ ok: false, message: 'Target range is outside the note.', tool: call.name, note })
    }
    const current = lines.slice(start - 1, end).join('\n')
    if (normalizeWhitespace(current) !== normalizeWhitespace(call.params.target_excerpt)) {
      return finish({
        ok: false,
        message: 'Anchor check failed: the target text moved before execution.',
        tool: call.name,
        note,
      })
    }
    // Blast radius: a removal of half the note or more is destructive no
    // matter who asked (audit TD-44). Waivable only by an explicit user
    // override (an approved blast-radius hold); bounds and anchor above
    // are never waived.
    const removed = end - start + 1
    if (!options.overrideBlastRadius && removed >= removalCapFor(lines.length)) {
      return finish({
        ok: false,
        message: `Removal exceeds the blast-radius limit: ${removed} of ${lines.length} lines${spanNote}.`,
        tool: call.name,
        note,
      })
    }
    const remaining = [...lines.slice(0, start - 1), ...lines.slice(end)]
    const nextLines = collapseBlankLines(remaining)
    const diff: ExecutionDiff = {
      startLine: start,
      before: lines.slice(start - 1, end),
      after: [],
      added: 0,
      removed: end - start + 1,
    }
    return finish({
      ok: true,
      message: `Removed ${diff.removed} line${diff.removed === 1 ? '' : 's'} from the note.`,
      tool: call.name,
      note: nextLines.length ? finalizeNote(nextLines) : '',
      diff,
    })
  }

  if (call.name === 'add_text') {
    const content = call.params.content ?? ''
    if (!content.trim()) {
      return finish({ ok: false, message: 'Insert payload is empty.', tool: call.name, note })
    }
    let block: NoteBlockResult | null = null
    if (call.params.position === 'under_heading') {
      block = insertUnderHeading(note, call.params.anchor ?? '', content)
    } else if (call.params.position === 'prepend') {
      block = prependContent(note, content)
    } else if (call.params.position === 'after_line') {
      block = insertAfterLine(note, Number(call.params.anchor), content)
    } else {
      block = appendContent(note, content)
    }
    if (!block) {
      return finish({ ok: false, message: 'Insertion anchor was not found.', tool: call.name, note })
    }
    const lines = splitLines(block.note)
    const inserted = lines.slice(block.startLine - 1, block.endLine)
    const diff: ExecutionDiff = {
      startLine: block.startLine,
      before: [],
      after: inserted,
      added: inserted.length,
      removed: 0,
    }
    return finish({
      ok: true,
      message: `Inserted ${inserted.length} line${inserted.length === 1 ? '' : 's'} at line ${block.startLine}.`,
      tool: call.name,
      note: block.note,
      diff,
    })
  }

  return finish({ ok: false, message: 'Unsupported tool.', tool: 'none', note })
}
