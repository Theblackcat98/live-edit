import type {
  BBoxTarget,
  CriticCheck,
  CriticResult,
  RouteDecision,
  SceneRegionId,
  SpanTarget,
  ToolName,
  ToolScore,
  WorkerCall,
} from '../types'
import {
  findHeading,
  findLineByText,
  findSectionEnd,
  getHeadings,
  getListItems,
  getParagraphs,
  lineRangeExcerpt,
  normalizeWhitespace,
  parseTableRow,
  splitLines,
} from './doc'
import { clamp, countWords, estimateTokens, sentenceCase, truncate } from './utils'
import { SCENE_REGIONS, VISUAL_MARKDOWN } from '../data/scene'
import { NOTE_PATH } from '../data/note'

export type PlanProblem = 'missing_target' | 'missing_content' | 'ambiguous'

export interface SupervisorPlan {
  span?: SpanTarget
  bbox?: BBoxTarget
  anchorHeading?: string
  addPosition?: 'append' | 'prepend' | 'after_line' | 'under_heading'
  addAnchor?: string
  addContent?: string
  newText?: string
  phrase?: string
  visualFormat?: 'markdown_table' | 'mermaid_diagram' | 'latex_block' | 'bullet_summary' | 'verbatim_ocr'
  extractedMarkdown?: string
  problem?: PlanProblem
  problemDetail?: string
  candidates?: { label: string; command: string }[]
}

const MUTATION_VERBS =
  /\b(add|append|insert|write|create|put|include|prepend|update|change|replace|edit|set|rename|correct|fix|amend|modify|adjust|shorten|rewrite|format|remove|delete|drop|erase|cut|clear|extract|pull|grab|copy|transcribe|ocr|import|capture|bring|take)\b/i

const VISUAL_NOUNS =
  /\b(slide|whiteboard|screen|camera|image|photo|video|frame|chart|graph|diagram|formula|table|sticky)\b/i

const SCENE_REFERENCE =
  /\b(slide|whiteboard|screen|camera|image|photo|video|frame|chart|graph|diagram|formula|sticky note|finance note)\b/i

const CONVERSATIONAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(hi|hey|hello|good morning|good afternoon|yo)\b/i, reason: 'Greeting.' },
  {
    pattern:
      /\b(what (can|do) you see|what am i looking at|describe (the |this )?(slide|scene|image|frame)|read (the |this )?slide|what'?s on (the |my )?screen)\b/i,
    reason: 'Visual question, no mutation requested.',
  },
  {
    pattern: /\b(summari[sz]e|summary|recap|tl;?dr|what'?s in the note|read (me )?the note)\b/i,
    reason: 'Note summary request.',
  },
  {
    pattern: /\b(what (just )?changed|last edit|what did you (just )?(do|change|undo|redo|revert)|undo history|diff)\b/i,
    reason: 'Session history question.',
  },
  {
    pattern:
      /\b(how (does|do) (this|you|it) work|explain (the |this )?(system|trinity|architecture|pipeline)|what model|which models)\b/i,
    reason: 'Architecture question.',
  },
  {
    pattern: /^(help|commands)\b|\bwhat can you do\b|\bhow do i\b/i,
    reason: 'Capability help request.',
  },
  {
    pattern: /\b(thank you|thanks|nice work|great|perfect|looks good)\b/i,
    reason: 'Conversational acknowledgement.',
  },
  {
    pattern:
      /\b(update me|give me an update|status|how many tokens|context budget|latency|memory)\b/i,
    reason: 'Status question.',
  },
  {
    pattern: /^(yes|no|okay|ok|sure|got it|right|mm+)[.!]?$/i,
    reason: 'Short conversational turn.',
  },
  {
    pattern: /\b(read that back|say that again|repeat that|what did you say)\b/i,
    reason: 'Repeat request.',
  },
]

const VAGUE_MUTATION =
  /^(?:please\s+|could you\s+|can you\s+)?(?:delete|remove|change|update|edit|replace|fix|make|shorten|clean up|rewrite|amend)\s+(?:that|this|it|those|these)(?:\s+(?:part|bit|thing|section|line|text|one|stuff))?(?:\s+(?:to|into|with|so it)\s+.+)?[.!]?$/i

export function routeCommand(command: string): RouteDecision {
  const clean = command.trim().replace(/\s+/g, ' ')
  const lower = clean.toLowerCase()

  const undoDirective =
    /^(?:please\s+)?(?:undo|revert|roll back)\b/i.test(clean) ||
    /\b(?:undo|revert|roll back)\s+(?:that|this|it|the last|last)\b/i.test(clean)
  if (undoDirective) {
    return {
      action: 'file_mutation',
      actionConfidence: 0.995,
      allowedTools: [],
      reason: 'Snapshot rollback short-circuits the worker and critic.',
      directive: 'undo',
    }
  }

  const redoDirective =
    /^(?:please\s+)?(?:redo|reapply)\b/i.test(clean) ||
    /\b(?:redo|reapply)\s+(?:that|this|it|the last|last)\b/i.test(clean) ||
    /\bapply that again\b/i.test(clean)
  if (redoDirective) {
    return {
      action: 'file_mutation',
      actionConfidence: 0.993,
      allowedTools: [],
      reason: 'Redo restores the next snapshot without model inference.',
      directive: 'redo',
    }
  }

  if (/^(?:update me|give me an update)\b/i.test(clean)) {
    return {
      action: 'conversational_only',
      actionConfidence: 0.94,
      allowedTools: [],
      reason: 'Status question, not a file mutation.',
    }
  }

  const startsMutation =
    /^(?:please\s+|could you\s+|can you\s+|would you\s+|will you\s+)?(?:add|append|insert|write|create|put|include|prepend|update|change|replace|edit|set|rename|correct|fix|amend|modify|adjust|shorten|rewrite|format|remove|delete|drop|erase|cut|clear|extract|pull|grab|copy|transcribe|ocr|import|capture|bring|take)\b/i.test(
      clean,
    )

  if (!startsMutation) {
    const conversational = CONVERSATIONAL_PATTERNS.find(({ pattern }) => pattern.test(clean))
    if (conversational) {
      return {
        action: 'conversational_only',
        actionConfidence: 0.96,
        allowedTools: [],
        reason: conversational.reason,
      }
    }
  }

  if (VAGUE_MUTATION.test(clean)) {
    const vagueTool: ToolName = /\b(delete|remove|drop|erase|cut|clear)\b/i.test(clean)
      ? 'remove_text'
      : /\b(add|insert|append|put|include|prepend)\b/i.test(clean)
        ? 'add_text'
        : 'edit_text'
    return {
      action: 'ambiguous_request',
      actionConfidence: 0.92,
      allowedTools: [],
      primaryTool: vagueTool,
      reason: 'The command contains a mutation verb but no grounded object.',
    }
  }

  if (!MUTATION_VERBS.test(lower)) {
    return {
      action: 'conversational_only',
      actionConfidence: 0.82,
      allowedTools: [],
      reason: 'No file-mutation intent detected in the turn.',
    }
  }

  if (
    !startsMutation &&
    /^(what|why|how|when|where|who|which|do|does|did|is|are|was|were|should|would|will|could|can)\b/i.test(
      clean,
    )
  ) {
    return {
      action: 'conversational_only',
      actionConfidence: 0.89,
      allowedTools: [],
      reason: 'Interrogative turn; the mutation verb was not an imperative.',
    }
  }

  const hasVisual = VISUAL_NOUNS.test(lower)
  const extractsFromVisual =
    /\b(extract|pull|grab|copy|transcribe|ocr|import|capture|bring|take)\b/i.test(lower) &&
    hasVisual
  const addsFromVisual =
    /\b(add|insert|put|write|save|copy|bring)\b/i.test(lower) &&
    (/\bfrom\s+(?:the\s+|this\s+|my\s+)?(?:slide|screen|camera|image|whiteboard|frame)\b/i.test(
      lower,
    ) ||
      /\b(?:this|that)\s+(?:table|formula|chart|diagram|slide|screen|whiteboard)\b/i.test(lower) ||
      (/\b(summary|summari[sz]e|transcri(?:be|ption)|ocr)\b/i.test(lower) &&
        /\b(slide|screen|camera|image|whiteboard|table|formula|chart|diagram)\b/i.test(lower)))
  const asksExtract = extractsFromVisual || addsFromVisual

  if (asksExtract) {
    return {
      action: 'file_mutation',
      actionConfidence: 0.95,
      allowedTools: [
        { name: 'extract_visual_to_note', p: 0.93 },
        { name: 'add_text', p: 0.11 },
      ],
      primaryTool: 'extract_visual_to_note',
      reason: 'Visual reference plus extraction verb. VL worker is the right target.',
    }
  }

  const removeVerb = /\b(remove|delete|drop|erase|cut|clear)\b/i.test(lower)
  const addVerb = /\b(add|append|insert|write|create|put|include|prepend)\b/i.test(lower)
  const editVerb =
    /\b(update|change|replace|edit|set|rename|correct|fix|amend|modify|adjust|shorten|rewrite|format)\b/i.test(
      lower,
    )

  let primaryTool: ToolName = 'edit_text'
  if (removeVerb) primaryTool = 'remove_text'
  else if (addVerb && !editVerb) primaryTool = 'add_text'
  else if (addVerb && editVerb) {
    primaryTool = /\b(add|append|insert|create|put)\b/i.test(lower) ? 'add_text' : 'edit_text'
  }

  const allowedTools: ToolScore[] = [{ name: primaryTool, p: 0.88 + Math.random() * 0.07 }]
  if (primaryTool === 'edit_text' && hasVisual) {
    allowedTools.push({ name: 'extract_visual_to_note', p: 0.19 })
  }
  if (primaryTool === 'remove_text') {
    allowedTools.push({ name: 'edit_text', p: 0.14 })
  }
  if (primaryTool === 'add_text') {
    allowedTools.push({ name: 'edit_text', p: 0.08 })
  }

  return {
    action: 'file_mutation',
    actionConfidence: 0.9 + Math.random() * 0.07,
    allowedTools: allowedTools.sort((a, b) => b.p - a.p),
    primaryTool,
    reason:
      primaryTool === 'remove_text'
        ? 'Imperative delete with an identifiable target; destructive safety gate armed.'
        : primaryTool === 'add_text'
          ? 'Insertion intent with supervisor-supplied anchor.'
          : 'Edit intent with supervisor-supplied target span.',
  }
}

interface SpanSearchResult {
  span: SpanTarget
  candidates: SpanTarget[]
}

const GENERIC_WORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'in',
  'into',
  'on',
  'at',
  'of',
  'for',
  'from',
  'with',
  'and',
  'or',
  'my',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'please',
  'note',
  'notes',
  'file',
  'document',
  'line',
  'lines',
  'row',
  'bullet',
  'point',
  'section',
  'heading',
  'text',
  'part',
  'thing',
  'slide',
  'screen',
  'camera',
  'image',
  'formula',
  'table',
  'chart',
  'update',
  'change',
  'replace',
  'edit',
  'remove',
  'delete',
  'add',
  'insert',
  'append',
  'put',
  'set',
  'write',
  'create',
  'pull',
  'grab',
  'copy',
  'extract',
  'bring',
  'take',
  'make',
  'say',
  'says',
  'saying',
  'reads',
  'reading',
  'value',
  'values',
  'final',
  'status',
  'revenue',
  'quarter',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%.\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((word) => word.length >= 2 && !GENERIC_WORDS.has(word))
}

function stemWord(word: string): string {
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1)
  return word
}

function expandLineSpan(note: string, lineNumber: number): { start: number; end: number } {
  const lines = splitLines(note)
  const line = lines[lineNumber - 1] ?? ''
  const total = lines.length

  if (/^\s*\|.*\|\s*$/.test(line)) {
    return { start: lineNumber, end: lineNumber }
  }
  if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
    return { start: lineNumber, end: lineNumber }
  }
  if (/^#{1,6}\s+/.test(line)) {
    return { start: lineNumber, end: lineNumber }
  }

  let start = lineNumber
  let end = lineNumber
  while (start > 1 && lines[start - 2].trim() !== '' && !/^#{1,6}\s+/.test(lines[start - 2])) {
    start -= 1
  }
  while (end < total && lines[end].trim() !== '' && !/^#{1,6}\s+/.test(lines[end])) {
    end += 1
  }
  return { start, end }
}

function makeSpan(
  note: string,
  startLine: number,
  endLine: number,
  confidence: number,
  reason: string,
  phrase?: string,
): SpanTarget {
  return {
    startLine,
    endLine,
    excerpt: lineRangeExcerpt(note, startLine, endLine),
    confidence: clamp(confidence, 0, 0.99),
    reason,
    phrase,
  }
}

function keywordSpan(note: string, command: string): SpanSearchResult | null {
  const words = tokenize(command)
  if (!words.length) return null
  const lines = splitLines(note)
  const frequencies = new Map<string, number>()
  for (const word of words) {
    frequencies.set(
      word,
      lines.reduce((total, line) => total + (line.toLowerCase().includes(word) ? 1 : 0), 0),
    )
  }

  const commandWords = command
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(stemWord)
    .filter((word) => word.length >= 4)
  let sectionHint: { start: number; end: number } | null = null
  let hintScore = 0
  for (const heading of getHeadings(note)) {
    if (heading.level < 2) continue
    const titleWords = heading.title
      .toLowerCase()
      .replace(/^\d+\.\s*/, '')
      .split(/[^a-z0-9]+/)
      .map(stemWord)
      .filter((word) => word.length >= 4)
    const score = titleWords.reduce(
      (total, word) => total + (commandWords.includes(word) ? 1 : 0),
      0,
    )
    if (score > hintScore) {
      hintScore = score
      sectionHint = {
        start: heading.line + 1,
        end: Math.max(heading.line + 1, findSectionEnd(note, heading) - 1),
      }
    }
  }
  const inSectionHint = (lineNumber: number) =>
    Boolean(
      sectionHint &&
        lineNumber >= sectionHint.start &&
        lineNumber <= sectionHint.end,
    )

  const candidates: Array<{ line: number; score: number; hits: string[] }> = []
  lines.forEach((line, index) => {
    if (!line.trim()) return
    const lower = line.toLowerCase()
    let score = 0
    const hits: string[] = []
    for (const word of words) {
      if (!lower.includes(word)) continue
      hits.push(word)
      const frequency = frequencies.get(word) ?? 1
      score += 1.4 + Math.log((lines.length + 1) / (frequency + 0.4))
    }
    if (score > 0) {
      if (/\b(bullet|point)\b/i.test(command) && /^\s*([-*+]|\d+\.)\s+/.test(line)) score += 1.2
      if (/\b(row|table)\b/i.test(command) && /^\s*\|/.test(line)) score += 1.2
      if (/\b(heading|section)\b/i.test(command) && /^#{1,6}\s+/.test(line)) score += 0.9
      if (/^#{1,6}\s+/.test(line) && !/\b(heading|section)\b/i.test(command)) score -= 1.4
      if (inSectionHint(index + 1) && !/^#{1,6}\s+/.test(line)) score += 2.2
      candidates.push({ line: index + 1, score, hits })
    }
  })

  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates[0]
  const second = candidates[1]
  const spread = second ? top.score - second.score : top.score
  const topSpanRange = expandLineSpan(note, top.line)
  const confidence = clamp(
    0.66 + Math.min(0.24, top.score / 16) + Math.min(0.05, spread / 20),
    0,
    0.97,
  )
  const span = makeSpan(
    note,
    topSpanRange.start,
    topSpanRange.end,
    confidence,
    `Matched distinctive token${top.hits.length > 1 ? 's' : ''} ${top.hits
      .map((hit) => `“${hit}”`)
      .join(', ')} at line ${top.line}.`,
  )
  const otherCandidates = candidates
    .slice(1, 4)
    .filter((candidate) => candidate.score > top.score * 0.62)
    .map((candidate) => {
      const range = expandLineSpan(note, candidate.line)
      return makeSpan(
        note,
        range.start,
        range.end,
        clamp(confidence - 0.1, 0.4, 0.9),
        `Alternative grounded span for “${candidate.hits.join(', ')}”.`,
      )
    })
  return { span, candidates: otherCandidates }
}

function allQuotes(command: string): string[] {
  const matches = [...command.matchAll(/"([^"]{2,200})"|“([^”]{2,200})”|'([^']{3,200})'|`([^`]{2,200})`/g)]
  return matches.map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').filter(Boolean)
}

function ordinalSpan(note: string, command: string): SpanTarget | null {
  const ordinals: Record<string, number> = {
    first: 0,
    second: 1,
    third: 2,
    fourth: 3,
    fifth: 4,
    last: -1,
  }
  const paragraphMatch = command.match(
    /\b(first|second|third|fourth|fifth|last)\s+paragraph\b/i,
  )
  if (paragraphMatch) {
    const paragraphs = getParagraphs(note)
    if (!paragraphs.length) return null
    const key = paragraphMatch[1].toLowerCase()
    const index = ordinals[key] === -1 ? paragraphs.length - 1 : ordinals[key]
    const paragraph = paragraphs[index]
    if (!paragraph) return null
    return makeSpan(
      note,
      paragraph.line,
      paragraph.endLine,
      0.9,
      `Ordinal reference resolved to paragraph ${index + 1}.`,
    )
  }

  const bulletMatch = command.match(
    /\b(first|second|third|fourth|fifth|last)\s+(?:bullet|item|point)\b/i,
  )
  if (bulletMatch) {
    const items = getListItems(note)
    if (!items.length) return null
    const key = bulletMatch[1].toLowerCase()
    const index = ordinals[key] === -1 ? items.length - 1 : ordinals[key]
    const item = items[index]
    if (!item) return null
    return makeSpan(note, item.line, item.line, 0.88, `Ordinal reference resolved to list item ${index + 1}.`)
  }
  return null
}

function explicitLineSpan(note: string, command: string): SpanTarget | null {
  const match = command.match(/\blines?\s+(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/i)
  if (!match) return null
  const total = splitLines(note).length
  const start = clamp(Number(match[1]), 1, total)
  const end = clamp(Number(match[2] ?? match[1]), start, total)
  return makeSpan(note, start, end, 0.97, 'Explicit line reference supplied by the user.')
}

function explicitHeadingReference(note: string, command: string) {
  const lower = command.toLowerCase()
  const sectionNumber = lower.match(/\bsection\s+(\d+)\b/)
  if (sectionNumber) {
    return findHeading(note, sectionNumber[1])
  }
  if (!/\b(section|heading|under|into|inside|after|before|to|in)\b/i.test(lower)) {
    return null
  }
  const headings = getHeadings(note)
  let best: { heading: (typeof headings)[number]; length: number } | null = null
  for (const heading of headings) {
    const title = heading.title.toLowerCase()
    const withoutNumber = title.replace(/^\d+\.\s*/, '')
    if (lower.includes(title) || lower.includes(withoutNumber)) {
      if (!best || withoutNumber.length > best.length) {
        best = { heading, length: withoutNumber.length }
      }
    }
  }
  return best?.heading ?? null
}

function headingSpan(note: string, heading: ReturnType<typeof explicitHeadingReference>): SpanTarget | null {
  if (!heading) return null
  const sectionEnd = findSectionEnd(note, heading) - 1
  const end = Math.max(heading.line, sectionEnd)
  return makeSpan(
    note,
    heading.line,
    end,
    0.91,
    `Section reference resolved to “${heading.title}” (lines ${heading.line}–${end}).`,
  )
}

function sectionTargetHeading(
  note: string,
  command: string,
): { heading: NonNullable<ReturnType<typeof explicitHeadingReference>>; scope: 'section' | 'heading' } | null {
  const numbered = command.match(/\bsection\s+(\d+)\b/i)
  if (numbered) {
    const heading = findHeading(note, numbered[1])
    if (heading) return { heading, scope: 'section' }
  }
  const match = command.match(
    /\b(?:remove|delete|drop|erase|clear|update|change|edit|replace|amend|modify)\s+(?:the\s+)?(.+?)\s+(section|heading)\b/i,
  )
  if (!match) return null
  const phrase = match[1].trim()
  if (/\b(?:in|from|under|inside|of|about|with|across)\b/i.test(phrase)) return null
  const heading = findHeading(note, phrase)
  if (!heading) return null
  return { heading, scope: match[2].toLowerCase() === 'heading' ? 'heading' : 'section' }
}

function extractReplacement(command: string): string | null {
  const quotes = allQuotes(command)
  if (quotes.length >= 2) {
    return quotes[quotes.length - 1].trim()
  }

  const match = command.match(
    /\b(?:to|as|with|saying|that says|reads?|becomes?|equals?)\s+(.+)$/i,
  )
  if (match) {
    let value = match[1].trim()
    value = value.replace(/\s+(?:in|on|under)\s+(?:the\s+)?(?:note|document|file|section\s+\d+)[.!]?$/i, '')
    value = value.replace(/\s+please[.!]?$/i, '')
    value = value.replace(/[.!?]$/, '')
    if (value.length > 1) return value.trim()
  }

  if (quotes.length === 1) {
    return quotes[0].trim()
  }
  return null
}

function buildTableRowReplacement(excerpt: string, replacement: string): string {
  const cells = parseTableRow(excerpt)
  if (cells.length < 2) return replacement
  const currency = replacement.match(/\$\s?[\d.,]+\s?[KMB]?/i)
  const plainNumber = replacement.match(/\b\d+(?:\.\d+)?\s?[KMB]\b/i)
  const status = replacement.match(/\b(pending|closed|final|forecast|approved|at risk|done|signed)\b/i)
  let changed = false
  if (currency) {
    cells[1] = currency[0].replace(/\s+/g, '').replace(/^([a-z])/, (character) => character.toUpperCase())
    changed = true
  } else if (plainNumber) {
    cells[1] = plainNumber[0].trim()
    changed = true
  }
  if (status) {
    cells[2] = status[1]
      .toLowerCase()
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
    changed = true
  }
  if (changed) {
    return `| ${cells.join(' | ')} |`
  }
  const values = replacement
    .split(/\s*[,–—|]\s*|\s+-\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length > 1) {
    for (let index = 0; index < Math.min(values.length, cells.length - 1); index += 1) {
      cells[index + 1] = values[index]
    }
    return `| ${cells.join(' | ')} |`
  }
  return replacement
}

function applyReplacementToSpan(
  note: string,
  span: SpanTarget,
  replacement: string,
  phrase?: string,
): string {
  const lines = splitLines(note)
  const targetLine = span.startLine - 1

  if (phrase && span.startLine === span.endLine) {
    const line = lines[targetLine]
    if (line && line.includes(phrase)) {
      return line.replace(phrase, replacement)
    }
  }

  if (span.startLine === span.endLine && /^\s*\|.*\|\s*$/.test(lines[targetLine] ?? '')) {
    return buildTableRowReplacement(lines[targetLine], replacement)
  }

  if (span.startLine === span.endLine) {
    const line = lines[targetLine] ?? ''
    const marker = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/)
    if (marker) {
      const body = replacement.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      return `${marker[1]}${body.charAt(0).toUpperCase()}${body.slice(1)}`
    }
    const heading = line.match(/^(#{1,6}\s+)(.*)$/)
    if (heading) {
      return `${heading[1]}${replacement.replace(/^#{1,6}\s+/, '')}`
    }
  }

  return replacement
}

function findSectionHeadingForInsertion(note: string, command: string) {
  return explicitHeadingReference(note, command)
}

function listMarkerForHeading(note: string, headingTitle: string): string {
  const heading = findHeading(note, headingTitle)
  if (!heading) return ''
  const lines = splitLines(note)
  let sawUnordered = false
  let maxOrdered = 0
  for (let index = heading.line; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^#{1,6}\s+/.test(line)) break
    const marker = line.match(/^\s*(?:[-*+]|\d+\.)\s+/)
    if (!marker) continue
    const ordered = line.match(/^\s*(\d+)\.\s+/)
    if (ordered) maxOrdered = Math.max(maxOrdered, Number(ordered[1]))
    else sawUnordered = true
  }
  if (maxOrdered > 0) return `${maxOrdered + 1}. `
  if (sawUnordered) return '- '
  return ''
}

function semanticAddContent(command: string): string | null {
  const lower = command.toLowerCase()
  if (/support backlog/.test(lower)) {
    return 'Support backlog is growing faster than the team can absorb.'
  }
  if (/launch checklist/.test(lower)) {
    return '## Launch checklist\n\n- [ ] Confirm release notes\n- [ ] Brief support and sales\n- [ ] Schedule the go / no-go review'
  }
  if (/follow[- ]?ups?|next steps|action items/.test(lower)) {
    return '- Confirm an owner and due date for each open decision.'
  }
  return null
}

function extractAddContent(command: string): string | null {
  const quoted = allQuotes(command)
  if (quoted.length) return quoted[quoted.length - 1].trim()

  const afterWith = command.match(/\b(?:with|containing|saying|that says|reads?)\s+(.+)$/i)
  if (afterWith) return afterWith[1].trim()

  const semantic = semanticAddContent(command)
  if (semantic) return semantic

  const afterVerb = command.match(
    /\b(?:add|append|insert|write|create|put|include|prepend)\s+(.+)$/i,
  )
  if (!afterVerb) return null
  let content = afterVerb[1].trim()
  content = content.replace(
    /\s+(?:under|into|inside|to|in|after|before)\s+(?:the\s+)?(?:section\s+\d+|[a-z][\w\s-]*section|note|document|file)[.!]?$/i,
    '',
  )
  content = content.replace(/\s+(?:at the (?:top|end|beginning)|please)[.!]?$/i, '')
  content = content.replace(/^(?:a|an|the)\s+/i, '')
  content = content.replace(/^(?:new\s+)?(?:note|line|bullet|item|section)\s+(?:about|on|for|called|titled)\s+/i, '')
  content = content.replace(/^(?:section|called|titled)\s+/i, '')
  content = content.trim()
  if (content.length < 2) return null
  if (content.length < 4 && !/[$\d]/.test(content)) return null
  return sentenceCase(content)
}

function visualRegionForCommand(command: string): SceneRegionId {
  const lower = command.toLowerCase()
  if (/\b(ltv|cac|formula|north star|ratio|metric)\b/.test(lower)) return 'formula'
  if (/\b(sticky|finance note|caveat)\b/.test(lower)) return 'sticky'
  if (/\b(chart|graph|bars?|trend)\b/.test(lower)) return 'chart'
  if (/\bq3\b|\bq3 row\b|\brevenue row\b/.test(lower)) return 'q3-row'
  if (/\b(table|revenue|q[1-4]|row)\b/.test(lower)) return 'table'
  if (/\b(header|title)\b/.test(lower)) return 'header'
  return 'full'
}

function makeBBox(region: SceneRegionId, confidence: number, source: 'camera' | 'screen' = 'camera'): BBoxTarget {
  return {
    region,
    label: SCENE_REGIONS[region].label,
    confidence,
    source,
  }
}

function visualFormatForRegion(region: SceneRegionId): SupervisorPlan['visualFormat'] {
  if (region === 'formula') return 'latex_block'
  if (region === 'table' || region === 'q3-row') return 'markdown_table'
  if (region === 'sticky' || region === 'header') return 'verbatim_ocr'
  return 'bullet_summary'
}

function defaultHeadingForRegion(region: SceneRegionId): string {
  if (region === 'sticky') return '4. Risks'
  if (region === 'full') return '1. Executive summary'
  return '2. Revenue'
}

function visualMarkdownForRegion(region: SceneRegionId): string {
  if (region === 'q3-row') return VISUAL_MARKDOWN.table
  return VISUAL_MARKDOWN[region as keyof typeof VISUAL_MARKDOWN] ?? VISUAL_MARKDOWN.full
}

function buildCandidates(
  note: string,
  tool: ToolName,
  replacement: string | null,
): { label: string; command: string }[] {
  const items = getListItems(note)
  const candidates: { label: string; command: string }[] = []

  const findItem = (needle: string) => items.find((item) => item.text.toLowerCase().includes(needle))
  const redis = findItem('redis')
  const api = findItem('api keys')
  const finance = findItem('finance to confirm')

  if (tool === 'remove_text') {
    if (redis) candidates.push({ label: 'Redis bullet', command: 'Remove the bullet about Redis' })
    if (api) candidates.push({ label: 'API-key bullet', command: 'Remove the bullet about API keys' })
    candidates.push({ label: 'Q3 revenue row', command: 'Remove the Q3 revenue row' })
    if (finance) {
      candidates.push({ label: 'Q3 follow-up', command: 'Remove the finance follow-up' })
    }
    return candidates.slice(0, 3)
  }

  if (tool === 'edit_text') {
    const suffix = replacement ? ` to ${replacement}` : ''
    candidates.push({ label: 'Q3 revenue row', command: `Update the Q3 revenue row${suffix || ' to $1.45M Final'}` })
    if (redis) candidates.push({ label: 'Redis bullet', command: `Change the Redis bullet${suffix || ' to keep the migration in Q4'}` })
    if (api) candidates.push({ label: 'API-key bullet', command: `Change the API-key bullet${suffix || ' to rotate keys by 15 November'}` })
    return candidates.slice(0, 3)
  }

  candidates.push({ label: 'Q3 revenue row', command: 'Update the Q3 revenue row to $1.45M Final' })
  candidates.push({ label: 'Redis bullet', command: 'Remove the bullet about Redis' })
  candidates.push({ label: 'Revenue section', command: 'Pull the LTV/CAC formula from the slide into Revenue' })
  return candidates
}

function findSpanForMutation(note: string, command: string): SpanSearchResult | null {
  const quoted = allQuotes(command)
  const firstQuoteIsTarget =
    quoted.length >= 2 ||
    /^(?:please\s+)?(?:replace|change|edit|update|remove|delete|drop|fix|rename)\s+["“'`]/i.test(
      command,
    )
  if (quoted.length && firstQuoteIsTarget) {
    const targetPhrase = quoted[0]
    const found = findLineByText(note, targetPhrase)
    if (found) {
      const range = expandLineSpan(note, found.line)
      return {
        span: makeSpan(note, range.start, range.end, 0.95, 'Exact quoted target found in the note.', targetPhrase),
        candidates: [],
      }
    }
  }

  const lineSpan = explicitLineSpan(note, command)
  if (lineSpan) return { span: lineSpan, candidates: [] }

  const ordinal = ordinalSpan(note, command)
  if (ordinal) return { span: ordinal, candidates: [] }

  const sectionTarget = sectionTargetHeading(note, command)
  if (sectionTarget) {
    if (sectionTarget.scope === 'heading') {
      return {
        span: makeSpan(
          note,
          sectionTarget.heading.line,
          sectionTarget.heading.line,
          0.92,
          `Heading reference resolved to “${sectionTarget.heading.title}”.`,
        ),
        candidates: [],
      }
    }
    const span = headingSpan(note, sectionTarget.heading)
    if (span) return { span, candidates: [] }
  }

  return keywordSpan(note, command)
}

export function buildPlan(
  command: string,
  route: RouteDecision,
  note: string,
): SupervisorPlan {
  const tool = route.primaryTool
  if (!tool || route.directive) return {}

  if (tool === 'extract_visual_to_note') {
    const region = visualRegionForCommand(command)
    const explicitHeading = findSectionHeadingForInsertion(note, command)
    const headingTitle = explicitHeading?.title ?? defaultHeadingForRegion(region)
    const heading = findHeading(note, headingTitle) ?? getHeadings(note)[1]
    const headingLine = heading?.line ?? 1
    const anchorHeading = heading?.title ?? 'Executive summary'
    return {
      bbox: makeBBox(region, 0.9 + Math.random() * 0.06),
      anchorHeading,
      visualFormat: visualFormatForRegion(region),
      extractedMarkdown: visualMarkdownForRegion(region),
      span: makeSpan(
        note,
        headingLine,
        headingLine,
        0.93,
        `ROI “${SCENE_REGIONS[region].label}” overlaps the note anchor “${anchorHeading}”.`,
      ),
    }
  }

  if (tool === 'add_text') {
    const heading = findSectionHeadingForInsertion(note, command)
    const afterLineMatch = command.match(/\bafter\s+line\s+(\d+)\b/i)
    let position: SupervisorPlan['addPosition'] = heading ? 'under_heading' : 'append'
    let anchor: string | undefined = heading?.title
    if (afterLineMatch) {
      position = 'after_line'
      anchor = afterLineMatch[1]
    } else if (/\b(at the (top|beginning)|prepend|start of (the )?(note|file))\b/i.test(command)) {
      position = 'prepend'
      anchor = undefined
    }

    let content = extractAddContent(command)
    if (!content) return { problem: 'missing_content', problemDetail: 'No insertion content detected.' }

    if (heading && !/^#{1,6}\s/.test(content) && !/^\s*([-*+]|\d+\.)\s+/.test(content)) {
      const marker = listMarkerForHeading(note, heading.title)
      if (marker) {
        content = `${marker}${content.charAt(0).toUpperCase()}${content.slice(1)}`
      }
    }

    const totalLines = splitLines(note).length
    const anchorLine = heading
      ? heading.line
      : afterLineMatch
        ? clamp(Number(afterLineMatch[1]), 1, totalLines)
        : totalLines
    return {
      addPosition: position,
      addAnchor: anchor,
      addContent: content,
      bbox: SCENE_REFERENCE.test(command) ? makeBBox(visualRegionForCommand(command), 0.87) : undefined,
      span: makeSpan(
        note,
        anchorLine,
        anchorLine,
        0.9,
        heading
          ? `Supervisor pinned insertion to “${heading.title}”.`
          : position === 'prepend'
            ? 'Insertion point at the top of the note.'
            : 'Insertion point at the document tail.',
      ),
    }
  }

  const found = findSpanForMutation(note, command)
  if (!found || found.span.confidence < 0.56) {
    return {
      problem: 'missing_target',
      problemDetail: found
        ? 'Competing spans share nearly equal probability.'
        : 'No span in the note matches the spoken target.',
      span: found?.span,
      candidates: buildCandidates(note, tool, extractReplacement(command)),
    }
  }

  if (tool === 'remove_text') {
    return {
      span: found.span,
      bbox: /q3|revenue|formula|slide|table/i.test(command)
        ? makeBBox(visualRegionForCommand(command), 0.88)
        : undefined,
    }
  }

  const replacement = extractReplacement(command)
  const quoted = allQuotes(command)
  const replacementIsTargetQuote =
    replacement !== null &&
    quoted.length === 1 &&
    replacement === quoted[0]
  if (!replacement || replacementIsTargetQuote) {
    return {
      span: found.span,
      problem: 'missing_content',
      problemDetail: 'Target grounded, but no replacement text was spoken.',
      candidates: buildCandidates(note, 'edit_text', null),
    }
  }

  const newText = applyReplacementToSpan(note, found.span, replacement, found.span.phrase)
  return {
    span: found.span,
    newText,
    bbox: /q3|revenue|formula|slide|table/i.test(command)
      ? makeBBox(visualRegionForCommand(command), 0.88)
      : undefined,
  }
}

export function critique(
  note: string,
  route: RouteDecision,
  span: SpanTarget | undefined,
  call: WorkerCall,
): CriticResult {
  const lines = splitLines(note)
  const checks: CriticCheck[] = []
  const params = call.params

  const allowed = route.allowedTools.some(
    (tool) => tool.name === call.name && tool.p > 0.25,
  )
  checks.push({
    label: 'tool_match',
    pass: allowed,
    detail: allowed ? `${call.name} was inside the pruned tool set.` : `${call.name} was not routed.`,
  })

  let rangeValid = true
  let anchorExact = true
  let targetGrounded = true
  let destructiveSafe = true

  if (call.name === 'edit_text' || call.name === 'remove_text') {
    const start = Number(params.start_line)
    const end = Number(params.end_line)
    rangeValid = Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= lines.length
    checks.push({
      label: 'range_in_bounds',
      pass: rangeValid,
      detail: rangeValid ? `Lines ${start}–${end} exist (${lines.length} total).` : 'Proposed range is outside the note.',
    })
    if (rangeValid) {
      const current = lines.slice(start - 1, end).join('\n')
      const anchor = call.name === 'edit_text' ? params.old_text_anchor : params.target_excerpt
      anchorExact = normalizeWhitespace(current) === normalizeWhitespace(anchor)
      checks.push({
        label: 'anchor_exact',
        pass: anchorExact,
        detail: anchorExact ? 'old_text_anchor matches the current lines exactly.' : 'Anchor drifted from the proposed span.',
      })
      if (span) {
        const overlaps = start <= span.endLine && end >= span.startLine
        targetGrounded = overlaps && Math.abs(start - span.startLine) <= 1
        checks.push({
          label: 'target_grounded',
          pass: targetGrounded,
          detail: targetGrounded
            ? `Call overlaps supervisor span ${span.startLine}–${span.endLine}.`
            : `Call ${start}–${end} is outside grounded span ${span.startLine}–${span.endLine}.`,
        })
      }
      if (call.name === 'remove_text') {
        const removed = end - start + 1
        destructiveSafe = removed < Math.max(9, Math.floor(lines.length * 0.5))
        checks.push({
          label: 'destructive_safety',
          pass: destructiveSafe,
          detail: destructiveSafe ? `${removed} line${removed === 1 ? '' : 's'} removed; below blast-radius limit.` : 'Removal exceeds the blast-radius limit.',
        })
      }
      if (call.name === 'edit_text' && current.length > 90) {
        const replacementLength = (params.new_text ?? '').trim().length
        const retainsContext = replacementLength >= current.length * 0.3
        destructiveSafe = destructiveSafe && retainsContext
        checks.push({
          label: 'blast_radius',
          pass: retainsContext,
          detail: retainsContext
            ? 'Replacement retains enough of the grounded block.'
            : 'Replacement collapses a large grounded block. Ask for a narrower target.',
        })
      }
    }
  }

  if (call.name === 'add_text') {
    const content = params.content?.trim() ?? ''
    const contentOk = content.length > 0
    checks.push({
      label: 'content_present',
      pass: contentOk,
      detail: contentOk ? 'Insert payload is non-empty.' : 'Insert payload is empty.',
    })
    if (params.position === 'under_heading') {
      const exists = Boolean(findHeading(note, params.anchor ?? ''))
      checks.push({
        label: 'anchor_exists',
        pass: exists,
        detail: exists ? `Heading “${params.anchor}” exists.` : 'Heading anchor not found.',
      })
      anchorExact = exists
    }
  }

  if (call.name === 'extract_visual_to_note') {
    const contentOk = (params.extracted_markdown ?? '').trim().length > 0
    const headingOk = Boolean(findHeading(note, params.anchor_heading ?? ''))
    checks.push({ label: 'content_present', pass: contentOk, detail: contentOk ? 'ROI Markdown is non-empty.' : 'ROI Markdown is empty.' })
    checks.push({
      label: 'anchor_exists',
      pass: headingOk,
      detail: headingOk ? `Heading “${params.anchor_heading}” exists.` : 'Anchor heading not found.',
    })
    anchorExact = headingOk
  }

  const allPass = checks.every((check) => check.pass)
  const pCorrect = clamp(
    allPass
      ? 0.91 + (route.actionConfidence - 0.9) * 0.2 + Math.random() * 0.035
      : 0.37 + Math.random() * 0.09,
    0,
    0.99,
  )
  const pSafe = clamp(destructiveSafe ? 0.975 + Math.random() * 0.02 : 0.58, 0, 0.999)
  const verdict = pCorrect >= 0.8 && pSafe >= 0.85 && allPass ? 'verified' : 'rejected'

  return {
    checks,
    pCorrect,
    pSafe,
    verdict,
    feedback:
      verdict === 'rejected'
        ? `Supervisor rejected call: ${checks
            .filter((check) => !check.pass)
            .map((check) => check.label)
            .join(', ')}. Retry with a grounded span and exact anchor.`
        : undefined,
  }
}

export function conversationalReply(
  command: string,
  note: string,
  lastRun: { command: string; status: string; executionMessage?: string } | null,
): string {
  const lower = command.toLowerCase()
  const words = countWords(note)
  const tokens = estimateTokens(note)
  const headings = getHeadings(note)

  if (/\b(what (can|do) you see|what am i looking at|describe|read (the |this )?slide|what'?s on (the |my )?screen)\b/i.test(lower)) {
    return 'You are showing a Q3 operating review slide. I can see a revenue table with Q3 marked pending, a north-star card reading LTV / CAC = 3.4×, a quarterly bar chart, and a finance sticky note about invoice reconciliation. The note on screen is open to the revenue section.'
  }

  if (/\b(summari[sz]e|summary|recap|tl;?dr|what'?s in the note|read (me )?the note)\b/i.test(lower)) {
    const sectionTitles = headings
      .filter((heading) => heading.level === 2)
      .map((heading) => heading.title.replace(/^\d+\.\s*/, ''))
    const countSectionItems = (title: string): number => {
      const heading = findHeading(note, title)
      if (!heading) return 0
      const end = findSectionEnd(note, heading) - 1
      return splitLines(note)
        .slice(heading.line, end)
        .filter((line) => /^\s*([-*+]|\d+\.)\s+/.test(line)).length
    }
    const q3Line = splitLines(note).find((line) => /^\|\s*Q3\s*\|/i.test(line))
    const q3Cells = q3Line ? parseTableRow(q3Line) : null
    const revenueStatus = q3Cells
      ? `Q3 revenue is ${q3Cells[1]} and marked ${q3Cells[2]?.toLowerCase() ?? 'unknown'}`
      : 'the Q3 revenue row is no longer in the table'
    return `It is a ${words}-word Q3 business review with ${sectionTitles.length} sections: ${sectionTitles.join(
      ', ',
    )}. ${revenueStatus[0].toUpperCase()}${revenueStatus.slice(1)}, with ${countSectionItems('Risks')} risks and ${countSectionItems('Follow-ups')} follow-ups still open.`
  }

  if (/\b(what (just )?changed|last edit|what did you (do|change)|diff)\b/i.test(lower)) {
    return lastRun
      ? `The last grounded command was “${lastRun.command}”. ${lastRun.executionMessage ?? 'The trace is available in the decision panel.'}`
      : 'No file edits yet this session. I am holding the note steady and watching the camera.'
  }

  if (/\b(how (does|do) (this|you|it) work|explain (the |this )?(system|trinity|architecture|pipeline)|what model|which models)\b/i.test(lower)) {
    return 'Three LFM3 models share one tri-hybrid backbone. Omni handles the live conversation, d1 runs zero-token checks to route and ground each command, and the VL worker writes the XML tool call. d1 verifies the call before the note engine touches a line.'
  }

  if (/\b(update me|give me an update|status|how many tokens|context budget|latency|memory)\b/i.test(lower)) {
    return `The note is ${words} words, roughly ${tokens} tokens. Omni is holding a rolling conversation window; d1 sees the full grounded note; the VL worker only receives the pruned tool schema and the target span. The trinity is using 5.1 GB of the 8 GB budget.`
  }

  if (/^(help|commands)\b|\bwhat can you do\b|\bhow do i\b/i.test(lower)) {
    return 'Try: “Update the Q3 revenue row to $1.45M Final”, “Remove the bullet about Redis”, or “Pull the LTV/CAC formula from the slide into Revenue”. You can also ask what I see, request a summary, or say “undo that”.'
  }

  if (/\b(thank you|thanks|nice work|great|perfect|looks good)\b/i.test(lower)) {
    return 'Anytime. The supervisor has the note and the camera frame in sync, so you can keep speaking naturally.'
  }

  if (/\b(read that back|say that again|repeat that|what did you say)\b/i.test(lower)) {
    return 'I said the last change is committed to the snapshot stack. Nothing leaves this machine, and the supervisor verified the span before execution.'
  }

  if (/^(hi|hey|hello|good morning|good afternoon|yo)\b/i.test(lower)) {
    return 'I am here. I can see the operating-review slide and your note. Tell me what to change, or ask me what I see.'
  }

  return 'I will keep that conversational. If you want the note changed, name the target and the edit — for example, “Update the Q3 revenue row to $1.45M Final.” I will not touch a line without a grounded span.'
}

export function buildClarification(
  note: string,
  command: string,
  tool: ToolName,
  problem: PlanProblem,
  _detail?: string,
): { text: string; actions: { label: string; command: string }[] } {
  const replacement = extractReplacement(command)
  const candidates = buildCandidates(note, tool, replacement)

  if (problem === 'missing_content') {
    return {
      text: 'I found the target, but no replacement text came through. Tell me what it should say and I will keep the rest of the note untouched.',
      actions: [],
    }
  }

  const intro =
    problem === 'ambiguous'
      ? 'I can make that change, but I need to know which part you mean.'
      : 'I could not ground that command to a single span, so I stopped before the worker ran.'
  return {
    text: `${intro} Did you mean ${candidates
      .slice(0, 2)
      .map((candidate) => `the ${candidate.label}`)
      .join(' or ')}?`,
    actions: candidates,
  }
}

export function tokenViewForWorker(
  note: string,
  span: SpanTarget | undefined,
  call: WorkerCall | null,
): string {
  const lines = splitLines(note)
  const windowStart = span ? Math.max(1, span.startLine - 3) : 1
  const windowEnd = span ? Math.min(lines.length, span.endLine + 3) : Math.min(24, lines.length)
  const numbered = lines
    .slice(windowStart - 1, windowEnd)
    .map((line, index) => `${String(windowStart + index).padStart(3, ' ')} │ ${line}`)
    .join('\n')
  return [`file: ${NOTE_PATH}`, `worker context: lines ${windowStart}–${windowEnd}`, '', numbered, '', call ? `tool call: ${call.name}` : ''].join('\n')
}

export function noteSignature(note: string): string {
  return `${countWords(note)} words · ${truncate(note.replace(/^#.*$/m, '').trim(), 80)}`
}
