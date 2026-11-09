import type {
  BBoxTarget,
  CriticCheck,
  CriticResult,
  GroundingSource,
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
  isTableSeparator,
  lineRangeExcerpt,
  normalizeWhitespace,
  parseTableRow,
  splitLines,
} from './doc'
import { clamp, countWords, estimateTokens, sentenceCase, truncate } from './utils'
import { d1Decide, type D1Question } from './bridge'
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
  /** Distinct alternative spans the deterministic search tied on (top span first). */
  spanCandidates?: SpanTarget[]
  /** The span came from a literal reference the user spelled out. */
  spanLiteral?: boolean
}

/**
 * Verb families shared by the router and the plan builder. Each stem carries
 * its gerund form because natural speech names the action as a process
 * ("begin by writing a readme") rather than an imperative. Keeping one
 * inventory here stops the family regexes from drifting apart.
 */
const ADD_VERB_SOURCE =
  'add(?:s|ing)?|append(?:s|ing)?|insert(?:s|ing)?|writ(?:e|es|ing)|creat(?:e|es|ing)|put(?:s|ting)?|include(?:s|ing)?|prepend(?:s|ing)?|make|makes|making|draft|drafts|drafting'
const EDIT_VERB_SOURCE =
  'update|updates|updating|change|changes|changing|replace|replaces|replacing|edit|edits|editing|set|sets|setting|rename|renames|renaming|correct|corrects|correcting|fix|fixes|fixing|amend|amends|amending|modify|modifies|modifying|adjust|adjusts|adjusting|shorten|shortens|shortening|rewrite|rewrites|rewriting|format|formats|formatting'
const REMOVE_VERB_SOURCE =
  'remove|removes|removing|delete|deletes|deleting|drop|drops|dropping|erase|erases|erasing|cut|cuts|cutting|clear|clears|clearing'
const EXTRACT_VERB_SOURCE =
  'extract|extracts|extracting|pull|pulls|pulling|grab|grabs|grabbing|copy|copies|copying|transcribe|transcribes|transcribing|ocr|import|imports|importing|capture|captures|capturing|bring|brings|bringing|take|takes|taking'

const MUTATION_VERBS = new RegExp(
  `\\b(?:${ADD_VERB_SOURCE}|${EDIT_VERB_SOURCE}|${REMOVE_VERB_SOURCE}|${EXTRACT_VERB_SOURCE})\\b`,
  'i',
)

const ADD_VERB = new RegExp(`\\b(?:${ADD_VERB_SOURCE})\\b`, 'i')
const EDIT_VERB = new RegExp(`\\b(?:${EDIT_VERB_SOURCE})\\b`, 'i')
const REMOVE_VERB = new RegExp(`\\b(?:${REMOVE_VERB_SOURCE})\\b`, 'i')
const EXTRACT_VERB = new RegExp(`\\b(?:${EXTRACT_VERB_SOURCE})\\b`, 'i')
const ADD_FROM_VISUAL_VERB = new RegExp(
  `\\b(?:${ADD_VERB_SOURCE}|save|saves|saving|copy|copies|copying|bring|brings|bringing)\\b`,
  'i',
)

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

/**
 * The d1-Omni routing questions (/v1/systemone). One forward pass maps a turn
 * onto an action class and, when the note must change, a tool.
 *
 * The conversational criterion has to name personal statements explicitly:
 * without that, d1 reads a fact like "my favorite number is 47" as note
 * content and returns file_mutation, so the user hits a clarification instead
 * of a chat reply. The mutation criteria stay imperative — "an instruction
 * addressed to you as a command" — which keeps real edit commands out of the
 * conversational class.
 */
export const ROUTE_QUESTIONS: Record<'action' | 'tool', D1Question> = {
  action: {
    type: 'choice',
    instructions:
      'Classify what the speaker wants relative to the note file and the attached slide. Statements about the user and questions about what you can see are conversation, not edits.',
    criteria: {
      conversational_only:
        'the user is talking to you, not asking for an edit: greetings, thanks, questions about the conversation or about what the camera and slide show, or telling you something about themselves — their name, preferences, numbers, or a fact to remember later. Hypothetical questions about what an edit would do ("what happens if I remove…") are conversation — answer them, never edit',
      file_mutation:
        'an instruction to change the note file, addressed to you as a command: add, edit, remove or extract content — creating or writing a whole document, note or template from scratch also counts as file_mutation',
      ambiguous_request:
        'a mutation verb, but the target object is missing or refers vaguely to "that" or "it"',
    },
  },
  tool: {
    type: 'choice',
    instructions: 'If the note file should change, which tool fits the command best?',
    criteria: {
      edit_text: 'replace existing lines with new text — any command shaped like "replace X with Y" is edit_text, never an insertion',
      remove_text: 'delete lines, a bullet or a table row',
      add_text: 'insert new content at a position or under a heading',
      extract_visual_to_note: 'read the visible slide and copy its content into the note',
    },
  },
}

export const VAGUE_MUTATION =
  /^(?:please\s+|could you\s+|can you\s+)?(?:delete|remove|change|update|edit|replace|fix|make|shorten|clean up|rewrite|amend)\s+(?:that|this|it|those|these)(?:\s+(?:part|bit|thing|section|line|text|one|stuff))?(?:\s+(?:to|into|with|so it)\s+.+)?[.!]?$/i

/**
 * True when the (normalized) command mutates a deictic reference — "delete
 * that part", "change it" — with no grounded object. The local router sends
 * these to clarification, and the live-route guardrail in useWorkspace uses
 * the same test to divert a d1 file_mutation upgrade before grounding can
 * guess a target (audit TD-43).
 */
export function isVagueMutation(command: string): boolean {
  return VAGUE_MUTATION.test(normalizeCommand(command))
}

const LEADING_FILLER = /^(?:(?:um|uh|er|ah|hey|okay|ok)[,!.]?\s+)+/i
const SCENE_SETTING =
  /^(?:(?:the|this)\s+(?:document|doc|note|page|file)\s+(?:is|seems|looks)\s+(?:currently\s+|still\s+|totally\s+|completely\s+|already\s+)?(?:empty|blank|clear)\s*(?:now|already|at the moment)?\s*[,.;:]?\s*)+/i
const LEADING_HEDGE =
  /^(?:(?:begin|start)\s+by\s+|go\s+ahead\s+and\s+|i\s+want\s+you\s+to\s+|i'?d\s+like\s+you\s+to\s+|please\s+|just\s+)+/i

/**
 * Strip the spoken scaffolding that precedes a real imperative. The trace and
 * chat bubble keep the raw utterance; routing and planning see this form.
 * Loops to a fixed point so it is idempotent and handles chained clauses
 * ("the document is empty now, please go ahead and write…").
 */
export function normalizeCommand(command: string): string {
  let text = command.trim().replace(/\s+/g, ' ')
  let previous = ''
  while (text !== previous) {
    previous = text
    text = text
      .replace(LEADING_FILLER, '')
      .replace(SCENE_SETTING, '')
      .replace(LEADING_HEDGE, '')
  }
  return text.trim()
}

const STARTS_MUTATION = new RegExp(
  `^(?:please\\s+|could you\\s+|can you\\s+|would you\\s+|will you\\s+)?(?:${ADD_VERB_SOURCE}|${EDIT_VERB_SOURCE}|${REMOVE_VERB_SOURCE}|${EXTRACT_VERB_SOURCE})\\b`,
  'i',
)

export function routeCommand(command: string): RouteDecision {
  const clean = normalizeCommand(command)
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

  const startsMutation = STARTS_MUTATION.test(clean)

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
  const extractsFromVisual = EXTRACT_VERB.test(lower) && hasVisual
  const addsFromVisual =
    ADD_FROM_VISUAL_VERB.test(lower) &&
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
      reason: 'Visual reference plus extraction verb. The deterministic visual extractor builds the call.',
    }
  }

  const removeVerb = REMOVE_VERB.test(lower)
  const addVerb = ADD_VERB.test(lower)
  const editVerb = EDIT_VERB.test(lower)

  let primaryTool: ToolName = 'edit_text'
  if (removeVerb) primaryTool = 'remove_text'
  else if (addVerb && !editVerb) primaryTool = 'add_text'
  else if (addVerb && editVerb) {
    primaryTool = /\b(?:add|adding|append|appending|insert|inserting|create|creating|put|putting)\b/i.test(lower)
      ? 'add_text'
      : 'edit_text'
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
  /** The user named the target literally (quote, line numbers, ordinal). */
  literal?: boolean
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

/**
 * Structural units a spoken reference can name. The bracket label shown to d1
 * and the noun filter that narrows the candidate view both use this
 * vocabulary, so "that section about API keys" and "the second paragraph" are
 * grounded against the kind of block the speaker actually said.
 *
 * Sentences are deliberately absent: the execution contract edits whole lines
 * (`start_line`/`end_line` + an exact anchor), so a sub-line candidate could
 * never be applied. A sentence reference resolves to its paragraph.
 */
type SpanKind = 'section' | 'heading' | 'paragraph' | 'bullet' | 'row' | 'table' | 'quote'

interface StructuralSpan extends SpanTarget {
  kind: SpanKind
}

const SPAN_KIND_LABELS: Record<SpanKind, string> = {
  section: 'section',
  heading: 'heading',
  paragraph: 'paragraph',
  bullet: 'list item',
  row: 'table row',
  table: 'table',
  quote: 'blockquote',
}

/** Every structural block in the note, in document order. */
function structuralSpans(note: string): StructuralSpan[] {
  const lines = splitLines(note)
  const spans: StructuralSpan[] = []
  const push = (startLine: number, endLine: number, kind: SpanKind, detail: string) => {
    if (startLine < 1 || endLine < startLine || endLine > lines.length) return
    const excerpt = lineRangeExcerpt(note, startLine, endLine)
    if (!excerpt) return
    const range = endLine === startLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`
    spans.push({
      startLine,
      endLine,
      excerpt,
      confidence: 0.6,
      kind,
      reason: `The ${SPAN_KIND_LABELS[kind]}${detail ? ` ${detail}` : ''} at ${range}.`,
    })
  }

  const headings = getHeadings(note)
  const hasSubheadings = headings.some((heading) => heading.level > 1)
  for (const heading of headings) {
    push(heading.line, heading.line, 'heading', `“${heading.title}”`)
    const end = Math.min(lines.length, findSectionEnd(note, heading) - 1)
    // An H1 section in a document with deeper headings covers the whole file;
    // offering "the entire note" as one candidate only invites a misfire.
    if (end > heading.line && !(heading.level === 1 && hasSubheadings)) {
      push(heading.line, end, 'section', `“${heading.title}”`)
    }
  }
  for (const paragraph of getParagraphs(note)) {
    push(paragraph.line, paragraph.endLine, 'paragraph', '')
  }
  for (const item of getListItems(note)) {
    push(item.line, item.line, 'bullet', '')
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*>\s?/.test(lines[index])) continue
    let end = index + 1
    while (end < lines.length && /^\s*>\s?/.test(lines[end])) end += 1
    push(index + 1, end, 'quote', '')
    index = end - 1
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\|/.test(lines[index])) continue
    let end = index + 1
    while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1
    for (let line = index + 1; line <= end; line += 1) {
      if (!isTableSeparator(lines[line - 1])) push(line, line, 'row', '')
    }
    if (end - index > 2) push(index + 1, end, 'table', '')
    index = end - 1
  }

  const seen = new Set<string>()
  return spans.filter((span) => {
    const key = `${span.startLine}:${span.endLine}:${span.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const SPAN_KIND_PATTERNS: Array<[SpanKind, RegExp]> = [
  ['section', /\bsections?\b/i],
  ['paragraph', /\bparagraphs?\b/i],
  ['bullet', /\b(?:bullets?|list items?|items?|points?|steps?)\b/i],
  ['row', /\brows?\b/i],
  ['table', /\btables?\b/i],
  ['quote', /\b(?:quotes?|block ?quotes?|callouts?)\b/i],
  ['heading', /\b(?:headings?|titles?|headlines?)\b/i],
]

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
  let topSpanRange = expandLineSpan(note, top.line)
  let sectionGrounded = false
  // A spoken "section" reference names the heading WITH its body — the same
  // unit the d1 structural path offers as a `section` candidate. Grounding
  // only the heading line let a whole-section replacement ("Replace the
  // Risks section with tiny") land on an 11-char target and sail under the
  // blast-radius check (audit TD-44). Rename-style phrasings still name the
  // heading line itself.
  if (
    /\bsections?\b/i.test(command) &&
    !/\b(?:heading|headings|title|rename|retitle|re-title)\b/i.test(command) &&
    /^#{1,6}\s+/.test(lines[top.line - 1] ?? '')
  ) {
    const heading = getHeadings(note).find((candidate) => candidate.line === top.line)
    if (heading) {
      const sectionEnd = Math.min(lines.length, findSectionEnd(note, heading) - 1)
      if (sectionEnd > heading.line) {
        topSpanRange = { start: heading.line, end: sectionEnd }
        sectionGrounded = true
      }
    }
  }
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
    sectionGrounded
      ? `Matched distinctive token${top.hits.length > 1 ? 's' : ''} ${top.hits
          .map((hit) => `“${hit}”`)
          .join(', ')} on the section heading at line ${top.line}; grounded the whole section (lines ${topSpanRange.start}–${topSpanRange.end}).`
      : `Matched distinctive token${top.hits.length > 1 ? 's' : ''} ${top.hits
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

  if (phrase) {
    // Surgical phrase replacement: swap exactly the quoted phrase inside the
    // one span line that contains it and keep every other line verbatim, so
    // a re-grounded multi-line span is edited in place instead of rewritten.
    for (let index = span.startLine - 1; index < span.endLine; index += 1) {
      const line = lines[index]
      if (!line || !line.includes(phrase)) continue
      if (span.startLine === span.endLine) return line.replace(phrase, replacement)
      const spanLines = lines.slice(span.startLine - 1, span.endLine)
      spanLines[index - (span.startLine - 1)] = line.replace(phrase, replacement)
      return spanLines.join('\n')
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

/**
 * Template/boilerplate creation is an initial-body request, not an insertion
 * of the spoken words. An erased document has no text to extend, so the
 * generic extractAddContent path would write the instruction itself
 * ("Readme template in this document, rename the title appropriately.") into
 * the note — a payload the critic must then reject as unsound. The template's
 * H1 is also the document title, which is what "rename the title" asks for.
 */
const TEMPLATE_NOUNS = /^(?:template|boilerplate|skeleton|scaffold|starter|outline)$/i
const TEMPLATE_WORD = /\b(?:template|boilerplate|skeleton|outline|starter|scaffold)\b/i
const DOC_TYPE_WORD = /\b(?:readme|read\s+me|changelog|faq|todo|meeting\s+notes|design\s+doc|spec)\b/i

const CREATION_VERB_SOURCE =
  'creat(?:e|es|ing)|writ(?:e|es|ing)|add(?:s|ing)?|make|makes|making|generate|generates|generating|draft|drafts|drafting|insert(?:s|ing)?|starting|starts|start|set up|prepar(?:e|es|ing)'

const CREATION_HEAD = new RegExp(
  `^(?:please\\s+)?(?:could you\\s+|can you\\s+|would you\\s+|will you\\s+)?(?:${CREATION_VERB_SOURCE})\\b`,
  'i',
)

/** Words that end the created artifact's name ("a readme template for …"). */
const TEMPLATE_SCOPE_STOPWORDS: Record<string, true> = {
  about: true,
  for: true,
  with: true,
  to: true,
  in: true,
  into: true,
  on: true,
  under: true,
  of: true,
  from: true,
  at: true,
  regarding: true,
  that: true,
  which: true,
  called: true,
  titled: true,
  named: true,
  saying: true,
  containing: true,
  using: true,
  inside: true,
}

const TEMPLATE_ARTIFACT_STOPWORDS: Record<string, true> = {
  a: true,
  an: true,
  the: true,
  new: true,
  blank: true,
  empty: true,
  fresh: true,
  simple: true,
  basic: true,
  default: true,
  full: true,
  complete: true,
  whole: true,
  md: true,
  markdown: true,
}

/** Conventional uppercase for document names that are acronyms by usage. */
const DOCUMENT_TITLE_FORMS: Record<string, string> = {
  readme: 'README',
  faq: 'FAQ',
  todo: 'TODO',
  api: 'API',
  cli: 'CLI',
}

function templateTitle(command: string): string {
  const withoutVerb = command
    .replace(/\.(?:md|markdown)\b/gi, ' ')
    .replace(
      new RegExp(
        `^(?:please\\s+)?(?:could you\\s+|can you\\s+|would you\\s+|will you\\s+)?(?:${CREATION_VERB_SOURCE})\\s+(?:a\\s+|an\\s+|the\\s+)?`,
        'i',
      ),
      '',
    )
  const phrase = withoutVerb.match(
    /^([a-z][\w-]*(?:\s+[a-z][\w-]*){0,2})\s+(?:template|boilerplate|skeleton|scaffold|starter|outline)\b/i,
  )
  let name = (phrase?.[1] ?? withoutVerb.match(/^(?:readme|read me)\b/i)?.[0] ?? '')
    .toLowerCase()
    .replace(/^read me$/, 'readme')
  if (!name) {
    // Name the artifact by its document kind ("… needs a changelog template")
    // before falling back to the generic template noun.
    name = (withoutVerb.toLowerCase().match(DOC_TYPE_WORD)?.[0] ?? '').replace(/^read me$/, 'readme')
  }
  if (!name) {
    // No artifact name ("create an outline") — title the template by its kind.
    name = (withoutVerb.toLowerCase().match(/\b(template|boilerplate|skeleton|scaffold|starter|outline)\b/)?.[1] ?? '')
  }
  const words = name
    .split(/\s+/)
    .filter((word) => word && !TEMPLATE_ARTIFACT_STOPWORDS[word])
  if (!words.length) return 'Document'
  return words
    .map((word) => DOCUMENT_TITLE_FORMS[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

function wantsDocumentTemplate(command: string): boolean {
  const head = command.match(CREATION_HEAD)
  if (!head) {
    // Natural phrasing often hides the verb behind a clause ("a readme
    // template would be good here"). A short command that names both a
    // document kind and a template noun is still a creation request.
    return command.length < 120 && DOC_TYPE_WORD.test(command) && TEMPLATE_WORD.test(command)
  }
  const words = command
    .slice(head[0].length)
    .toLowerCase()
    .split(/[^a-z-]+/)
    .filter(Boolean)
  let contentWords = 0
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (TEMPLATE_SCOPE_STOPWORDS[word]) return false
    if (
      /^(?:new|blank|empty)$/.test(word) &&
      /^(?:document|file|page)$/.test(words[index + 1] ?? '')
    ) {
      return true
    }
    if (TEMPLATE_ARTIFACT_STOPWORDS[word]) continue
    contentWords += 1
    if (contentWords > 3) return false
    if (TEMPLATE_NOUNS.test(word)) return true
  }
  return false
}

function buildDocumentTemplate(command: string): string | null {
  if (!wantsDocumentTemplate(command)) return null

  return [
    `# ${templateTitle(command)}`,
    '',
    '## Overview',
    '',
    'Describe what this project does, who it is for, and why it matters.',
    '',
    '## Getting started',
    '',
    '- Prerequisites',
    '- Installation',
    '',
    '## Usage',
    '',
    'Explain the main workflow with a short example.',
    '',
    '## Contributing',
    '',
    'Describe how others can report issues or propose changes.',
    '',
    '## License',
    '',
    'State the license for this work.',
  ].join('\n')
}

function extractAddContent(command: string): string | null {
  const quoted = allQuotes(command)
  if (quoted.length) return quoted[quoted.length - 1].trim()

  const afterWith = command.match(/\b(?:with|containing|saying|that says|reads?)\s+(.+)$/i)
  if (afterWith) return afterWith[1].trim()

  const semantic = semanticAddContent(command)
  if (semantic) return semantic

  const afterVerb = command.match(new RegExp(`\\b(?:${ADD_VERB_SOURCE})\\s+(.+)$`, 'i'))
  if (!afterVerb) return null
  let content = afterVerb[1].trim()
  // A trailing clause that is itself an instruction ("…, rename the title
  // appropriately") describes what to do with the document, not text to write.
  content = content.replace(
    /,\s*(?:and\s+)?(?:rename|re-?title|retitle|title|name|label|call|format|restyle|style)\b[\s\S]*$/i,
    '',
  )
  content = content.replace(
    /\s+(?:under|into|inside|to|in|after|before)\s+(?:the\s+|this\s+|that\s+|my\s+)?(?:section\s+\d+|[a-z][\w\s-]*section|note|document|file)[.!]?$/i,
    '',
  )
  content = content.replace(/\s+(?:at the (?:top|end|beginning)|please)[.!]?$/i, '')
  content = content.replace(/^(?:a|an|the)\s+/i, '')
  content = content.replace(/^(?:new\s+)?(?:note|line|bullet|item|section)\s+(?:about|on|for|called|titled)\s+/i, '')
  // "add a line under Security: rotate keys monthly" — the target phrase is
  // the insertion point, not payload; only a colon-separated heading name
  // follows the location word, so drop everything up to it.
  content = content.replace(
    /^(?:new\s+)?(?:line|row|bullet|item|entry|point)\s+(?:under|in|inside|below|beneath)\s+[^:]{2,60}:\s*/i,
    '',
  )
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

/**
 * Deterministic span search: the fallback when d1-Omni's typed span question
 * is unavailable, plus the literal pre-empts a model should never re-decide —
 * an exact quote, explicit line numbers, or an ordinal position ("the second
 * bullet"), all of which are exact by construction and where a miscounting
 * model can only introduce drift.
 *
 * Vague references are d1's job now — structural grounding enumerates the
 * note's sections, paragraphs, list items, rows, tables and blockquotes and
 * asks d1 which one the command names (see resolveGroundingSpan).
 */
function findSpanForMutation(note: string, command: string): SpanSearchResult | null {
  const quoted = allQuotes(command)
  const firstQuoteIsTarget =
    quoted.length >= 2 ||
    /^(?:please\s+)?(?:replace|replacing|change|changing|edit|editing|update|updating|remove|removing|delete|deleting|drop|dropping|fix|fixing|rename|renaming)\s+["“'`]/i.test(
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
        literal: true,
      }
    }
  }

  const lineSpan = explicitLineSpan(note, command)
  if (lineSpan) return { span: lineSpan, candidates: [], literal: true }

  const ordinal = ordinalSpan(note, command)
  if (ordinal) return { span: ordinal, candidates: [], literal: true }

  return keywordSpan(note, command)
}

export function buildPlan(
  rawCommand: string,
  route: RouteDecision,
  note: string,
): SupervisorPlan {
  const command = normalizeCommand(rawCommand)
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
    const blankNote = note.trim().length === 0
    let position: SupervisorPlan['addPosition'] = heading
      ? 'under_heading'
      : blankNote
        ? 'prepend'
        : 'append'
    let anchor: string | undefined = heading?.title
    if (afterLineMatch) {
      position = 'after_line'
      anchor = afterLineMatch[1]
    } else if (/\b(at the (top|beginning)|prepend|start of (the )?(note|file))\b/i.test(command)) {
      position = 'prepend'
      anchor = undefined
    }

    // An erased document cannot be extended by "inserting" the spoken words:
    // a template/boilerplate request defines the document body itself.
    let content = (blankNote ? buildDocumentTemplate(command) : null) ?? extractAddContent(command)
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
          : blankNote
            ? 'The document is empty — the new content becomes the document body.'
            : position === 'prepend'
              ? 'Insertion point at the top of the note.'
              : 'Insertion point at the document tail.',
      ),
    }
  }

  const found = findSpanForMutation(note, command)
  const spanCandidates = found
    ? distinctSpans([found.span, ...found.candidates])
    : []
  if (!found || found.span.confidence < 0.56) {
    return {
      problem: 'missing_target',
      problemDetail: found
        ? 'Competing spans share nearly equal probability.'
        : 'No span in the note matches the spoken target.',
      span: found?.span,
      spanCandidates,
      spanLiteral: found?.literal,
      candidates: buildCandidates(note, tool, extractReplacement(command)),
    }
  }

  if (tool === 'remove_text') {
    return {
      span: found.span,
      spanCandidates,
      spanLiteral: found.literal,
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
      spanCandidates,
      spanLiteral: found.literal,
      problem: 'missing_content',
      problemDetail: 'Target grounded, but no replacement text was spoken.',
      candidates: buildCandidates(note, 'edit_text', null),
    }
  }

  const newText = applyReplacementToSpan(note, found.span, replacement, found.span.phrase)
  return {
    span: found.span,
    spanCandidates,
    spanLiteral: found.literal,
    newText,
    bbox: /q3|revenue|formula|slide|table/i.test(command)
      ? makeBBox(visualRegionForCommand(command), 0.88)
      : undefined,
  }
}

function distinctSpans(spans: SpanTarget[]): SpanTarget[] {
  const seen = new Set<string>()
  const out: SpanTarget[] = []
  for (const span of spans) {
    const key = `${span.startLine}:${span.endLine}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(span)
  }
  return out
}

export interface GroundingResolution {
  span?: SpanTarget
  /** Plan fields the live grounding refined (problem, newText). */
  planPatch?: { problem?: PlanProblem; problemDetail?: string; newText?: string }
  source: GroundingSource
  /** d1-Omni probability for the chosen candidate (live path only). */
  p?: number
  /** Typed-question latency in ms (live path only). */
  ms?: number
  promptTokens?: number
  /** Why the fallback ran (the deterministic path's caption). */
  detail?: string
  /** True when d1 grounded a target the deterministic search could not. */
  resolvedMiss: boolean
  /** Structural candidates the grounding question considered. */
  offered: number
  candidates: SpanTarget[]
}

const SPAN_CHOICE_QUESTION = 'span_choice'
const SPAN_REGION_QUESTION = 'span_region'
const D1_GROUNDING_CAPTION = 'd1-Omni · /v1/systemone'
const LOCAL_GROUNDING_CAPTION = 'local heuristics'
/** Unified pruning gate from plan.md §10: below this a choice is not a decision. */
const GROUNDING_MIN_P = 0.25
/** d1 only overturns a deterministic miss when its choice is decisive. */
const GROUNDING_DECISIVE_P = 0.5
/** d1's server may omit the distribution; its argmax is still the decision. */
const DEFAULT_CHOICE_P = 0.6
const GROUNDING_TIMEOUT_MS = 12_000
/** The note text is the authoritative context the candidate excerpts index into. */
const GROUNDING_NOTE_LIMIT = 6000
/** d1's typed choice head is asked about one page of candidates at a time. */
const MAX_SPAN_CHOICES = 40

interface D1ChoiceAnswer {
  choice: string
  p: number
  ms: number
  promptTokens: number
}

async function askD1Choice(
  command: string,
  note: string,
  question: { id: string; instructions: string; criteria: Record<string, string> },
): Promise<D1ChoiceAnswer | null> {
  const decision = await d1Decide({
    state: `User command: ${command}\nNote under edit (line numbers are 1-based):\n${truncate(note, GROUNDING_NOTE_LIMIT)}`,
    timeoutMs: GROUNDING_TIMEOUT_MS,
    questions: {
      [question.id]: {
        type: 'choice',
        instructions: question.instructions,
        criteria: question.criteria,
      },
    },
  })
  const answer = decision.answers[question.id]
  if (!answer || answer.type !== 'choice' || !/^option_\d+$/.test(answer.choice)) return null
  const probability = answer.probabilities?.[answer.choice]
  return {
    choice: answer.choice,
    p: typeof probability === 'number' ? probability : DEFAULT_CHOICE_P,
    ms: decision.ms,
    promptTokens: decision.usage.promptTokens,
  }
}

function spanCriteria(spans: StructuralSpan[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  spans.forEach((span, index) => {
    const range =
      span.endLine === span.startLine ? `L${span.startLine}` : `L${span.startLine}–${span.endLine}`
    criteria[`option_${index + 1}`] = `${range} [${span.kind}]: ${truncate(
      span.excerpt.replace(/\s*\n\s*/g, ' / '),
      120,
    )}`
  })
  return criteria
}

function regionCriteria(chunks: StructuralSpan[][]): Record<string, string> {
  const criteria: Record<string, string> = {}
  chunks.forEach((chunk, index) => {
    const first = chunk[0]
    const last = chunk[chunk.length - 1]
    criteria[`option_${index + 1}`] = `L${first.startLine}–${last.endLine}: ${truncate(
      chunk
        .slice(0, 3)
        .map((span) => span.excerpt.replace(/\s*\n\s*/g, ' / '))
        .join(' … '),
      160,
    )}`
  })
  return criteria
}

/**
 * d1-Omni typed span grounding (plan.md §4 Stage B).
 *
 * The note is enumerated deterministically into structural blocks — heading
 * sections, headings, paragraphs, list items, table rows and tables,
 * blockquotes — narrowed to the kinds the spoken reference actually names
 * ("the bullet about Redis" offers list items only), and d1 answers one typed
 * choice question whose options are those blocks. Its top choice is adopted
 * when the calibrated probability clears the unified p ≥ 0.25 gate; a
 * deterministic miss (no keyword/quote/line candidate at all) is only
 * overturned when d1 is decisive (p ≥ 0.5), so vague turns like "change the
 * number" still clarify instead of inventing a target.
 *
 * Notes with more than 40 candidate blocks are grounded in two typed passes
 * (region, then block inside the region). A d1 outage, malformed answer or
 * sub-threshold choice keeps the deterministic search — the trace records
 * which path ran.
 */
export async function resolveGroundingSpan(
  command: string,
  note: string,
  plan: SupervisorPlan,
  tool: ToolName,
  options: { live?: boolean } = {},
): Promise<GroundingResolution> {
  const localCandidates = distinctSpans(
    plan.span ? [plan.span, ...(plan.spanCandidates ?? [])] : (plan.spanCandidates ?? []),
  )
  const fallback = (detail: string): GroundingResolution => ({
    span: plan.span
      ? { ...plan.span, reason: `${plan.span.reason} · ${LOCAL_GROUNDING_CAPTION} (${detail}).` }
      : undefined,
    source: 'fallback-keyword',
    detail,
    resolvedMiss: false,
    offered: localCandidates.length,
    candidates: localCandidates,
  })

  // Insertion anchors (add_text, visual extraction) are structural pins, not
  // spans a spoken reference chooses.
  if (tool !== 'edit_text' && tool !== 'remove_text') {
    return fallback(
      plan.span ? 'insertion anchors are pinned deterministically' : 'no mutation target to ground',
    )
  }
  // A quote or explicit line range is literal; re-deciding it invites drift.
  if (plan.spanLiteral) return fallback('literal reference, no d1 call')
  if (options.live === false) return fallback(`${D1_GROUNDING_CAPTION} is not probed`)

  const enumerated = structuralSpans(note)
  const namedKinds = SPAN_KIND_PATTERNS.filter(([, pattern]) => pattern.test(command)).map(
    ([kind]) => kind,
  )
  const filtered = namedKinds.length
    ? enumerated.filter((span) => namedKinds.includes(span.kind))
    : enumerated
  const offered = filtered.length ? filtered : enumerated
  if (!offered.length) return fallback('the note has no structural blocks')
  const miss = !plan.span || plan.problem === 'missing_target'

  try {
    let pool = offered
    let regionMs = 0
    if (pool.length > MAX_SPAN_CHOICES) {
      const chunks: StructuralSpan[][] = []
      for (let index = 0; index < pool.length; index += MAX_SPAN_CHOICES) {
        chunks.push(pool.slice(index, index + MAX_SPAN_CHOICES))
      }
      if (chunks.length > MAX_SPAN_CHOICES) return fallback('too many blocks to ground in one pass')
      const region = await askD1Choice(command, note, {
        id: SPAN_REGION_QUESTION,
        instructions:
          'The note is split into contiguous regions. Choose the region that contains the part of the note the user command refers to.',
        criteria: regionCriteria(chunks),
      })
      if (!region) return fallback('d1-Omni returned no region')
      if (region.p < GROUNDING_MIN_P) {
        return fallback(`d1-Omni chose ${region.choice} at p ${region.p.toFixed(2)}, below the region gate`)
      }
      const regionIndex = Number(region.choice.replace(/^option_/, '')) - 1
      const chunk = chunks[regionIndex]
      if (!chunk) return fallback('d1-Omni chose an unknown region')
      pool = chunk
      regionMs = region.ms
    }

    const answer = await askD1Choice(command, note, {
      id: SPAN_CHOICE_QUESTION,
      instructions:
        'The user command names one target inside the note. Choose the single candidate span the command refers to. The bracketed word is the span granularity: section = a heading with its body, heading = the heading line only, paragraph = one prose block, bullet = one list item, row = one table row, table = the whole table, quote = one blockquote.',
      criteria: spanCriteria(pool),
    })
    if (!answer) return fallback('d1-Omni returned no span choice')
    const chosen = pool[Number(answer.choice.replace(/^option_/, '')) - 1]
    if (!chosen) return fallback('d1-Omni chose an unknown span')
    const gate = miss ? GROUNDING_DECISIVE_P : GROUNDING_MIN_P
    if (answer.p < gate) {
      return fallback(
        `d1-Omni chose ${answer.choice} at p ${answer.p.toFixed(2)}, below the p≥${gate} gate`,
      )
    }
    // "the finance follow-up" already grounded to the one bullet; a low-confidence
    // pick of the enclosing Follow-ups section is drift, not a decision. When the
    // command names no block kind, the narrower local span wins unless d1 is
    // decisive.
    if (
      !miss &&
      !namedKinds.length &&
      plan.span &&
      answer.p < GROUNDING_DECISIVE_P &&
      chosen.startLine <= plan.span.startLine &&
      chosen.endLine >= plan.span.endLine &&
      (chosen.startLine !== plan.span.startLine || chosen.endLine !== plan.span.endLine)
    ) {
      return fallback('d1-Omni picked the enclosing block; kept the tighter local span')
    }

    const span: SpanTarget = {
      startLine: chosen.startLine,
      endLine: chosen.endLine,
      excerpt: chosen.excerpt,
      confidence: clamp(0.6 + answer.p * 0.35, 0, 0.97),
      reason: `${D1_GROUNDING_CAPTION} chose ${answer.choice} of ${pool.length} structural candidates (${chosen.kind}, p ${answer.p.toFixed(2)}).`,
    }

    const planPatch: GroundingResolution['planPatch'] = {}
    if (tool === 'edit_text') {
      const replacement = extractReplacement(command)
      const quoted = allQuotes(command)
      // One quote inside an edit is the target, not the replacement.
      const targetOnlyQuote =
        replacement !== null && quoted.length === 1 && replacement === quoted[0]
      if (replacement && !targetOnlyQuote) {
        // Preserve phrase precision across the re-ground: the target quote
        // the user spoke (or the pre-d1 plan span's phrase) keeps the edit
        // surgical instead of rewriting the whole d1-chosen span.
        const phrase = quoted.length ? quoted[0] : plan.span?.phrase
        planPatch.newText = applyReplacementToSpan(note, span, replacement, phrase)
      } else if (miss) {
        planPatch.problem = 'missing_content'
        planPatch.problemDetail = 'Target grounded, but no replacement text was spoken.'
      }
    }
    if (miss && !planPatch.problem) {
      planPatch.problem = undefined
      planPatch.problemDetail = undefined
    }

    return {
      span,
      planPatch: Object.keys(planPatch).length ? planPatch : undefined,
      source: 'd1-span',
      p: answer.p,
      ms: Number((regionMs + answer.ms).toFixed(1)),
      promptTokens: answer.promptTokens,
      resolvedMiss: miss,
      offered: pool.length,
      candidates: [span, ...pool.filter((candidate) => candidate !== chosen).slice(0, 7)],
    }
  } catch {
    return fallback(`${D1_GROUNDING_CAPTION} unavailable`)
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

  const primary = call.name === route.primaryTool
  const allowed = route.allowedTools.some(
    (tool) => tool.name === call.name && tool.p > 0.25,
  )
  const toolMatch = primary || allowed
  checks.push({
    label: 'tool_match',
    pass: toolMatch,
    detail: toolMatch
      ? primary
        ? `${call.name} is the routed primary tool.`
        : `${call.name} was inside the pruned tool set.`
      : `${call.name} was not routed.`,
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
      // The anchor is validated against the SUPERVISOR'S span, not the call's
      // own range: a worker that invents a range and copies its text would
      // otherwise always agree with itself (audit TD-01).
      const anchorSource = span ? span.excerpt : current
      anchorExact = normalizeWhitespace(anchorSource) === normalizeWhitespace(anchor)
      checks.push({
        label: 'anchor_exact',
        pass: anchorExact,
        detail: anchorExact
          ? span
            ? 'old_text_anchor matches the grounded span exactly.'
            : 'old_text_anchor matches the current lines exactly.'
          : 'Anchor drifted from the grounded span.',
      })
      if (span) {
        // The whole call range must sit inside the grounded span (±1 line of
        // adjacency tolerance). Checking only the call's start let an 8-line
        // removal pass against a 1-line span (audit TD-01).
        const confined = start >= span.startLine - 1 && end <= span.endLine + 1
        targetGrounded = confined
        checks.push({
          label: 'target_grounded',
          pass: targetGrounded,
          detail: targetGrounded
            ? `Call lines ${start}–${end} sit inside supervisor span ${span.startLine}–${span.endLine}.`
            : `Call ${start}–${end} is not confined to grounded span ${span.startLine}–${span.endLine}.`,
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
      if (call.name === 'edit_text') {
        // A replacement that keeps under 30% of the target's length guts it,
        // at ANY target size — the old 90-character floor let short-target
        // gutting through (audit TD-44).
        const replacementLength = (params.new_text ?? '').trim().length
        const retainsContext = replacementLength >= current.length * 0.3
        destructiveSafe = destructiveSafe && retainsContext
        checks.push({
          label: 'blast_radius',
          pass: retainsContext,
          detail: retainsContext
            ? `Replacement retains enough of the target (${replacementLength} of ${current.length} characters).`
            : 'Replacement collapses the grounded target. Ask for a narrower target.',
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
    return 'Three LFM3 models share one tri-hybrid backbone. Omni handles the live conversation, d1 runs zero-token checks to route and ground each command, and the 1.7B worker writes the XML tool call. d1 verifies the call before the note engine touches a line.'
  }

  if (/\b(update me|give me an update|status|how many tokens|context budget|latency|memory)\b/i.test(lower)) {
    return `The note is ${words} words, roughly ${tokens} tokens. Omni is holding a rolling conversation window; d1 sees the full grounded note; the 1.7B worker only receives the pruned tool schema and the target span. The trinity is using 5.1 GB of the 8 GB budget.`
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
    if (note.trim().length === 0) {
      return {
        text: "The document is empty — I can start it for you. Try 'create a readme template' or tell me the first line.",
        actions: [],
      }
    }
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
