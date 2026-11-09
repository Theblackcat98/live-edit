#!/usr/bin/env node
/**
 * Phase-0 spike E4 — worker authoring capability.
 *
 * Question (architecture-refactor.md §4 E4): given the design.md §6 worker
 * packet (directive + context packet + FULL line-numbered note + full 4-tool
 * catalog), how often does LFM3-1.7B emit a parseable, correctly grounded
 * call on the FIRST attempt?
 *
 * Method: 12 fixture directives (the QA battery's edit commands, the
 * design.md §13.1 README case on the seed note AND a bare `# Untitled` note,
 * and one §13.2 follow-up whose context packet carries 3 prior edit turns).
 * Each fixture POSTs http://127.0.0.1:8080/v1/chat/completions (the repo's
 * bridge contract: model alias `lfm3-1.7b`, non-streaming, temperature 0.3 /
 * max_tokens 3000 like the shipped live worker path) with a prompt built per
 * design.md §6. Scoring is per fixture:
 *   - parse    : the repo's parseToolCallXml rules (duplicated below)
 *   - params   : required params present and typed (repo TOOL_DEFS + the
 *                engine's integer/enum checks in executeTool)
 *   - anchor   : range bounds + whitespace-normalized anchor equality vs the
 *                fixture note (design.md §8 hard gates, tools.ts semantics)
 *   - latency  : wall-clock ms per attempt (+ llama.cpp token usage when the
 *                server reports it)
 * Failures get exactly ONE retry with the parse/anchor error appended to the
 * conversation (P3 retry policy; retry sampler mirrors the repo's attempt-2
 * bump: temperature 0.4).
 *
 * Repo rules are DUPLICATED in this script, not imported: src/ is TypeScript
 * and cannot be loaded from a dependency-free .mjs. Duplicated verbatim from:
 *   src/lib/xml.ts      (parseToolCallXml, KNOWN_TOOLS)
 *   src/lib/doc.ts      (splitLines, normalizeWhitespace, parseHeading,
 *                        getHeadings, findHeading)
 *   src/lib/tools.ts    (removalCapFor, EDIT_RETENTION_RATIO — informational)
 *   src/data/tools.ts   (TOOL_DEFS)
 *   src/data/note.ts    (NOTE_PATH, INITIAL_NOTE)
 *   src/data/scene.ts   (VISUAL_MARKDOWN.formula — the frame_extract payload)
 *
 * Output: docs/spikes/E4-worker-authoring.json (raw results — every number in
 * the summary doc comes from that file, which comes from an actual run).
 *
 * No new dependencies: Node 22 built-in fetch only. Sequential requests,
 * ~250 ms apart, 180 s per-request timeout (worker generations are slow).
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SERVER = 'http://127.0.0.1:8080'
const MODEL_ALIAS = 'lfm3-1.7b' // bridge.ts ENDPOINTS alias for the 1.7B on :8080
const REQUEST_TIMEOUT_MS = 180_000
const INTER_REQUEST_DELAY_MS = 250
const ATTEMPT1 = { temperature: 0.3, maxTokens: 3000 } // useWorkspace worker attempt 1
const RETRY = { temperature: 0.4, maxTokens: 3000 } // repo attempt-2 sampler bump

// --------------------------------------------------------------------------
// Repo rules duplicated verbatim (see header note).
// --------------------------------------------------------------------------

const KNOWN_TOOLS = ['add_text', 'edit_text', 'remove_text', 'extract_visual_to_note']

/** src/lib/xml.ts parseToolCallXml — byte-for-byte rule copy. */
function parseToolCallXml(xml) {
  const think = xml.match(/<think>([\s\S]*?)<\/think>/)?.[1]?.trim()
  const functionMatch = xml.match(/<function=([a-z_]+)>([\s\S]*?)<\/function>/)
  if (!functionMatch) return null
  const name = functionMatch[1]
  if (!KNOWN_TOOLS.includes(name)) return null
  const params = {}
  const parameterRegex = /<parameter=([a-z_]+)>\s*([\s\S]*?)\s*<\/parameter>/g
  let parameterMatch
  while ((parameterMatch = parameterRegex.exec(functionMatch[2])) !== null) {
    params[parameterMatch[1]] = parameterMatch[2].trim()
  }
  return { name, params, think }
}

/** src/lib/doc.ts */
function splitLines(note) {
  return note.split('\n')
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function parseHeading(raw) {
  const match = raw.match(/^(#{1,6})\s+(.*)$/)
  if (!match) return null
  return { line: 0, level: match[1].length, title: match[2].trim(), raw }
}

function getHeadings(note) {
  const lines = splitLines(note)
  const headings = []
  lines.forEach((line, index) => {
    const heading = parseHeading(line)
    if (heading) headings.push({ ...heading, line: index + 1 })
  })
  return headings
}

function findHeading(note, query) {
  const headings = getHeadings(note)
  const normalizedQuery = normalizeWhitespace(query).toLowerCase()
  if (!normalizedQuery) return null
  const exact = headings.find((heading) => heading.title.toLowerCase() === normalizedQuery)
  if (exact) return exact
  const strippedQuery = normalizedQuery.replace(/^#+\s*/, '')
  if (/^\d+$/.test(strippedQuery)) {
    const section = headings.find((heading) => {
      const match = heading.title.match(/^(\d+)\.\s/)
      return match ? Number(match[1]) === Number(strippedQuery) : false
    })
    return section ?? null
  }
  const contains = headings.find((heading) => {
    const title = heading.title.toLowerCase()
    return title.includes(strippedQuery) || strippedQuery.includes(title.replace(/^\d+\.\s*/, ''))
  })
  if (contains) return contains
  const sectionNumber = strippedQuery.match(/^(?:section\s+)?(\d+)$/)
  if (sectionNumber) {
    return headings.find((heading) => heading.title.toLowerCase().startsWith(`${sectionNumber[1]}.`)) ?? null
  }
  const words = strippedQuery.split(/\s+/).filter((word) => word.length > 2)
  if (!words.length) return null
  let best = null
  for (const heading of headings) {
    const title = heading.title.toLowerCase()
    const score = words.reduce((total, word) => total + (title.includes(word) ? word.length : 0), 0)
    if (score > 0 && (!best || score > best.score)) best = { heading, score }
  }
  return best?.heading ?? null
}

/** src/lib/tools.ts — informational only (design §8 blast radius). */
function removalCapFor(lineCount) {
  return Math.max(9, Math.floor(lineCount * 0.5))
}
const EDIT_RETENTION_RATIO = 0.3

/** src/data/tools.ts TOOL_DEFS, verbatim. */
const TOOL_DEFS = [
  {
    name: 'add_text',
    description:
      'Insert new text or Markdown at a precise position: append, prepend, after a line, or under a heading.',
    params: [
      { name: 'file_path', type: 'string', required: true, description: 'Target note path.' },
      {
        name: 'position',
        type: 'enum: append | prepend | after_line | under_heading',
        required: true,
        description: 'Where the content is inserted.',
      },
      {
        name: 'anchor',
        type: 'string | integer',
        required: false,
        description: 'Line number or exact heading supplied by the supervisor.',
      },
      { name: 'content', type: 'string', required: true, description: 'Markdown to insert.' },
    ],
  },
  {
    name: 'edit_text',
    description:
      'Replace a grounded line span with updated text. The old anchor must match the current note.',
    params: [
      { name: 'file_path', type: 'string', required: true, description: 'Target note path.' },
      { name: 'start_line', type: 'integer', required: true, description: '1-based first line.' },
      { name: 'end_line', type: 'integer', required: true, description: '1-based last line.' },
      {
        name: 'old_text_anchor',
        type: 'string',
        required: true,
        description: 'Exact text currently in the target span.',
      },
      { name: 'new_text', type: 'string', required: true, description: 'Replacement text.' },
    ],
  },
  {
    name: 'remove_text',
    description:
      'Delete a grounded line span, bullet, row or section after the critic verifies the target.',
    params: [
      { name: 'file_path', type: 'string', required: true, description: 'Target note path.' },
      { name: 'start_line', type: 'integer', required: true, description: '1-based first line.' },
      { name: 'end_line', type: 'integer', required: true, description: '1-based last line.' },
      {
        name: 'target_excerpt',
        type: 'string',
        required: true,
        description: 'Confirmation snippet of the text being removed.',
      },
    ],
  },
  {
    name: 'extract_visual_to_note',
    description:
      'Convert a visual ROI (table, formula, chart, whiteboard) into structured Markdown and insert it under a heading.',
    params: [
      { name: 'file_path', type: 'string', required: true, description: 'Target note path.' },
      {
        name: 'visual_format',
        type: 'enum: markdown_table | mermaid_diagram | latex_block | bullet_summary | verbatim_ocr',
        required: true,
        description: 'Requested Markdown representation.',
      },
      {
        name: 'anchor_heading',
        type: 'string',
        required: true,
        description: 'Heading supplied by the supervisor.',
      },
      {
        name: 'extracted_markdown',
        type: 'string',
        required: true,
        description: 'Structured Markdown extracted from the ROI.',
      },
    ],
  },
]

/** src/data/note.ts, verbatim. */
const NOTE_PATH = 'notes/quarterly-review.md'
const INITIAL_NOTE = `# Q3 Business Review

Prepared for the operating review on 14 November. Figures are provisional until finance sign-off. The narrative below focuses on revenue quality, product execution, and the decisions needed before the board meeting.

## 1. Executive summary

Revenue grew 18% quarter over quarter, led by self-serve expansion in the mid-market. Net revenue retention held at 112%, while gross margin improved 2.1 points.

> Decision needed: approve the Q4 hiring plan before the next board meeting.

## 2. Revenue

| Quarter | Revenue | Status |
| --- | --- | --- |
| Q1 | $0.92M | Closed |
| Q2 | $1.08M | Closed |
| Q3 | $1.2M | Pending |
| Q4 | $1.35M | Forecast |

The Q3 figure is waiting on the final enterprise invoice reconciliation. Finance expects to close the gap this week.

## 3. Product notes

- Shipped the new workspace permissions model.
- Redis cache migration was postponed to Q4.
- Mobile capture beta reached 1,200 weekly users.

## 4. Risks

1. Enterprise pipeline concentration remains high.
2. Support volume is tracking 12% above plan.
3. Hiring depends on the revised Q4 plan.

## 5. Follow-ups

- Finance to confirm Q3 revenue by Friday.
- Dana to share the revised hiring model.

## 6. Security

- Rotate production API keys before 30 November.
- Complete the SSO audit with IT.
`

/** src/data/scene.ts VISUAL_MARKDOWN.formula, verbatim (Omni's frame read). */
const FRAME_EXTRACT_FORMULA = `**North star — LTV / CAC**

$$
\\frac{\\mathrm{LTV}}{\\mathrm{CAC}} = 3.4\\times
$$

Target floor: 3.0×. Captured from the camera feed at 14:06.`

// The follow-up fixture's note: the seed note after the 3 prior edit turns in
// its context packet actually completed (title renamed → Redis bullet removed
// → Q3 row updated). Built by transformation so it can't drift from the seed.
const FOLLOWUP_NOTE = (() => {
  const lines = splitLines(INITIAL_NOTE)
  const out = []
  for (const line of lines) {
    if (line === '# Q3 Business Review') {
      out.push('# Q3 Review Final') // prior turn 1: rename title
    } else if (line === '- Redis cache migration was postponed to Q4.') {
      continue // prior turn 2: Redis bullet removed
    } else if (line === '| Q3 | $1.2M | Pending |') {
      out.push('| Q3 | $1.45M | Final |') // prior turn 3 (most recent): Q3 row updated
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
})()

const UNTITLED_NOTE = '# Untitled\n'

// --------------------------------------------------------------------------
// Worker packet prompt (design.md §6) — system + user message builders.
// --------------------------------------------------------------------------

const WORKER_SYSTEM_PROMPT = `You are the edit worker inside a local note-editing pipeline. A supervising conversation model heard the user and resolved the request into a typed directive. Your single job: AUTHOR the edit — write the new content yourself, ground your own target span in the note, and emit exactly one tool call in the XML contract.

Output format — think briefly inside <think></think>, then emit exactly one <tool_call> block and stop:

<tool_call>
<function=edit_text>
<parameter=file_path>
notes/quarterly-review.md
</parameter>
<parameter=start_line>
17
</parameter>
<parameter=end_line>
17
</parameter>
<parameter=old_text_anchor>
| Q3 | $1.2M | Pending |
</parameter>
<parameter=new_text>
| Q3 | $1.45M | Final |
</parameter>
</function>
</tool_call>

Rules:
- You author the content: write new_text / content yourself from the directive's brief. Never copy the user's command words into the note.
- You ground the target: choose the line numbers (or position + anchor) yourself from the line-numbered note in the user message. Anchor parameters must repeat the note's actual text at your chosen lines exactly.
- You choose the tool: pick the right one from the full catalog in the user message. The directive's "task" field is a hint, not a restriction.
- Use only the catalog's tools and parameters. Do not invent tool or parameter names.
- Emit exactly one tool call. No prose outside <think></think> and the tool call.`

function renderSchemas() {
  // Identical rendering to worker.ts buildWorkerMessages, all 4 tools.
  return TOOL_DEFS.map((tool) => {
    const params = tool.params
      .map(
        (param) =>
          `  ${param.name} (${param.type}${param.required ? ', required' : ''}): ${param.description}`,
      )
      .join('\n')
    return `<schema function=${tool.name}>\n${tool.description}\n${params}\n</schema>`
  }).join('\n')
}

function numberedNote(note) {
  // Same column format the repo's tokenViewForWorker uses — but the FULL note.
  const lines = splitLines(note)
  return lines.map((line, index) => `${String(index + 1).padStart(3, ' ')} │ ${line}`).join('\n')
}

function renderContextPacket(turns) {
  if (!turns.length) return '  (none yet — this is the first edit of the session)'
  return turns
    .map(
      (turn, index) =>
        `  ${index + 1}. user said: "${turn.userCommand}"\n` +
        `     directive: ${turn.directiveSummary}\n` +
        `     diff: ${turn.diffSummary}`,
    )
    .join('\n')
}

function buildUserMessage(fixture) {
  return [
    'DIRECTIVE from the supervising model (typed; it is authoritative):',
    JSON.stringify(fixture.directive, null, 2),
    '',
    'CONTEXT — last 3 completed edit turns (background only; the directive wins):',
    renderContextPacket(fixture.contextPacket),
    '',
    `CURRENT NOTE — ${NOTE_PATH}, full text, every line numbered (line numbers in the left column; line 1 is the first line):`,
    numberedNote(fixture.note()),
    '',
    'TOOL CATALOG — all four tools; choose the one that fits:',
    renderSchemas(),
    '',
    'Emit one tool call now.',
  ].join('\n')
}

// --------------------------------------------------------------------------
// Scoring (parse / params / anchor-grounding), repo rules.
// --------------------------------------------------------------------------

function scoreParse(text, reasoning) {
  // useWorkspace's xmlInput construction, duplicated: prefer raw text when it
  // carries <think>, else wrap llama.cpp's separate reasoning_content.
  const xmlInput = /<think>/.test(text) ? text : reasoning ? `<think>${reasoning}</think>\n${text}` : text
  const callCount = (xmlInput.match(/<function=/g) || []).length
  const parsed = parseToolCallXml(xmlInput)
  return { xmlInput, callCount, parsed, ok: parsed !== null }
}

function scoreParams(parsed) {
  const problems = []
  const def = TOOL_DEFS.find((tool) => tool.name === parsed.name)
  if (!def) return { ok: false, problems: [`unknown tool "${parsed.name}"`] }
  for (const param of def.params) {
    if (!param.required) continue
    const value = parsed.params[param.name]
    if (value === undefined || String(value).trim() === '') {
      problems.push(`missing required param "${param.name}"`)
    }
  }
  // Typed checks mirroring executeTool's guards.
  if (parsed.name === 'edit_text' || parsed.name === 'remove_text') {
    for (const key of ['start_line', 'end_line']) {
      if (!Number.isInteger(Number(parsed.params[key]))) {
        problems.push(`param "${key}" is not an integer (got ${JSON.stringify(parsed.params[key])})`)
      }
    }
  }
  if (parsed.name === 'add_text') {
    const position = parsed.params.position
    const positions = ['append', 'prepend', 'after_line', 'under_heading']
    if (!positions.includes(position)) {
      problems.push(`param "position" must be one of ${positions.join(' | ')} (got ${JSON.stringify(position)})`)
    } else if (position === 'after_line' && !Number.isInteger(Number(parsed.params.anchor))) {
      problems.push('position "after_line" requires an integer anchor line number')
    }
  }
  return { ok: problems.length === 0, problems }
}

function scoreGrounding(parsed, note) {
  const lines = splitLines(note)
  if (parsed.name === 'edit_text' || parsed.name === 'remove_text') {
    const start = Number(parsed.params.start_line)
    const end = Number(parsed.params.end_line)
    const boundsOk =
      Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= lines.length
    if (!boundsOk) {
      return {
        ok: false,
        boundsOk: false,
        anchorOk: false,
        start,
        end,
        detail: `range ${start}–${end} is out of bounds for the ${lines.length}-line note`,
        blastRadiusOk: null,
      }
    }
    const current = lines.slice(start - 1, end).join('\n')
    const anchorKey = parsed.name === 'edit_text' ? 'old_text_anchor' : 'target_excerpt'
    const anchorOk = normalizeWhitespace(current) === normalizeWhitespace(parsed.params[anchorKey] ?? '')
    // Informational (design §8): blast radius as executeTool would judge it.
    let blastRadiusOk = null
    let blastNote = ''
    if (parsed.name === 'remove_text') {
      const removed = end - start + 1
      const cap = removalCapFor(lines.length)
      blastRadiusOk = removed < cap
      blastNote = `removal ${removed} of ${lines.length} lines (cap ${cap})`
    } else if (String(parsed.params.new_text ?? '').trim().length > 0) {
      const retained = parsed.params.new_text.trim().length
      blastRadiusOk = retained >= current.length * EDIT_RETENTION_RATIO
      blastNote = `retained ${retained} of ${current.length} chars (floor ${Math.floor(current.length * EDIT_RETENTION_RATIO)})`
    }
    return {
      ok: anchorOk,
      boundsOk: true,
      anchorOk,
      start,
      end,
      anchorKey,
      actualText: current,
      detail: anchorOk
        ? `anchor matches note lines ${start}–${end}`
        : `anchor mismatch at lines ${start}–${end}`,
      blastRadiusOk,
      blastNote,
    }
  }
  if (parsed.name === 'add_text') {
    const position = parsed.params.position
    if (position === 'under_heading') {
      const heading = findHeading(note, parsed.params.anchor ?? '')
      return heading
        ? { ok: true, boundsOk: true, anchorOk: true, detail: `anchor heading "${parsed.params.anchor}" found at line ${heading.line}`, blastRadiusOk: null }
        : { ok: false, boundsOk: true, anchorOk: false, detail: `anchor heading ${JSON.stringify(parsed.params.anchor)} not found in the note`, blastRadiusOk: null }
    }
    if (position === 'after_line') {
      const anchor = Number(parsed.params.anchor)
      const boundsOk = Number.isInteger(anchor) && anchor >= 1 && anchor <= lines.length
      return {
        ok: boundsOk,
        boundsOk,
        anchorOk: boundsOk,
        detail: boundsOk ? `after_line ${anchor} is in bounds` : `after_line ${anchor} is out of bounds for the ${lines.length}-line note`,
        blastRadiusOk: null,
      }
    }
    if (position === 'append' || position === 'prepend') {
      return { ok: true, boundsOk: true, anchorOk: true, detail: `position "${position}" needs no anchor`, blastRadiusOk: null }
    }
    return { ok: false, boundsOk: false, anchorOk: false, detail: `position ${JSON.stringify(position)} is not resolvable`, blastRadiusOk: null }
  }
  if (parsed.name === 'extract_visual_to_note') {
    const heading = findHeading(note, parsed.params.anchor_heading ?? '')
    return heading
      ? { ok: true, boundsOk: true, anchorOk: true, detail: `anchor heading "${parsed.params.anchor_heading}" found at line ${heading.line}`, blastRadiusOk: null }
      : { ok: false, boundsOk: true, anchorOk: false, detail: `anchor heading ${JSON.stringify(parsed.params.anchor_heading)} not found in the note`, blastRadiusOk: null }
  }
  return { ok: false, boundsOk: false, anchorOk: false, detail: 'unknown tool', blastRadiusOk: null }
}

function retryErrorMessage(parseScore, paramsScore, groundScore) {
  const parts = []
  if (!parseScore.ok) {
    parts.push(
      'Your reply could not be parsed as a tool call. Reply again: think briefly inside <think></think>, then emit exactly one block of the form\n' +
        '<tool_call>\n<function=tool_name>\n<parameter=param_name>\nvalue\n</parameter>\n</function>\n</tool_call>\n' +
        'with no other text.',
    )
  }
  if (parseScore.ok && paramsScore && !paramsScore.ok) {
    parts.push(`Your ${parseScore.parsed.name} call has parameter problems: ${paramsScore.problems.join('; ')}.`)
  }
  if (parseScore.ok && groundScore && !groundScore.ok) {
    if (groundScore.actualText !== undefined) {
      parts.push(
        `Your anchor does not match the note. The note's actual text at lines ${groundScore.start}–${groundScore.end} is:\n` +
          '"""\n' + groundScore.actualText + '\n"""\n' +
          'Copy that text exactly into the anchor parameter — or choose the correct line range for the text you meant.',
      )
    } else {
      parts.push(`Grounding problem: ${groundScore.detail}.`)
    }
  }
  return 'ERROR — your tool call was rejected by the deterministic gates.\n' + parts.join('\n\n') + '\n\nReply again with exactly one corrected tool call.'
}

// --------------------------------------------------------------------------
// Server client (bridge.ts chatComplete equivalent, non-streaming).
// --------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function chatComplete(messages, sampler, label) {
  const startedAt = Date.now()
  try {
    const res = await fetch(`${SERVER}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_ALIAS,
        messages,
        temperature: sampler.temperature,
        max_tokens: sampler.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const ms = Date.now() - startedAt
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}`, ms, text: '', reasoning: '' }
    }
    const payload = await res.json()
    const choice = payload?.choices?.[0]?.message ?? {}
    const text = String(choice.content ?? '').trim()
    const reasoning = String(choice.reasoning_content ?? '').trim()
    const usage = payload?.usage ?? {}
    const timings = payload?.timings ?? {}
    return {
      ok: true,
      ms,
      text,
      reasoning,
      promptTokens: usage.prompt_tokens ?? timings.prompt_n ?? null,
      outputTokens: usage.completion_tokens ?? timings.predicted_n ?? null,
      serverModel: payload?.model ?? null,
      error: !text && !reasoning ? 'empty completion' : null,
    }
  } catch (err) {
    return {
      ok: false,
      error: `${label}: ${err?.name === 'TimeoutError' ? 'request timed out' : (err?.message ?? String(err))}`,
      ms: Date.now() - startedAt,
      text: '',
      reasoning: '',
    }
  }
}

// --------------------------------------------------------------------------
// Fixtures — QA battery edit commands + design.md §13.1/§13.2 cases.
// --------------------------------------------------------------------------

const EMPTY_PACKET = []

const FOLLOWUP_PACKET = [
  {
    userCommand: 'Rename the title to Q3 Review Final',
    directiveSummary: 'edit · Replace the H1 title "# Q3 Business Review" (line 1) with "# Q3 Review Final".',
    diffSummary: 'edit_text lines 1–1: "# Q3 Business Review" → "# Q3 Review Final" (applied).',
  },
  {
    userCommand: 'remove the bullet about Redis',
    directiveSummary: 'remove · Delete the Product notes bullet "Redis cache migration was postponed to Q4.".',
    diffSummary: 'remove_text 1 line ("- Redis cache migration was postponed to Q4.") — removed (applied).',
  },
  {
    userCommand: 'update the Q3 revenue row to $1.45M Final',
    directiveSummary: 'edit · In the Revenue table, set the Q3 row to Revenue $1.45M, Status Final.',
    diffSummary: 'edit_text 1 line: "| Q3 | $1.2M | Pending |" → "| Q3 | $1.45M | Final |" (applied).',
  },
]

const FIXTURES = [
  {
    id: 'F01',
    label: 'edit · Q3 revenue row (QA 6)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'update the Q3 revenue row to $1.45M Final',
    directive: {
      task: 'edit',
      instruction:
        'Update the Q3 revenue row in the Revenue table: set Revenue to $1.45M and Status to Final.',
      target: { description: 'the Q3 row of the Revenue table under "## 2. Revenue"', heading: '2. Revenue' },
      verbatim: null,
      constraints: ['markdown table row', 'leave the other rows unchanged'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'edit_text',
  },
  {
    id: 'F02',
    label: 'remove · Redis bullet (QA 7)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'remove the bullet about Redis',
    directive: {
      task: 'remove',
      instruction: 'Remove the Product notes bullet about the Redis cache migration.',
      target: { description: 'the Redis bullet in "## 3. Product notes"', heading: '3. Product notes' },
      verbatim: null,
      constraints: ['keep the other Product notes bullets'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'remove_text',
  },
  {
    id: 'F03',
    label: 'insert · line under Security (QA 8)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'add a line under Security: rotate keys monthly',
    directive: {
      task: 'insert',
      instruction: 'Add a line to the Security section of the note, after its existing bullets.',
      target: { description: 'under the "## 6. Security" heading', heading: '6. Security' },
      verbatim: 'rotate keys monthly',
      constraints: ['keep the existing Security bullets'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'add_text',
  },
  {
    id: 'F04',
    label: 'insert · spoken bullet under Follow-ups (QA 19)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'hey, could you add a bullet under Follow-ups saying send the deck to finance',
    directive: {
      task: 'insert',
      instruction: 'Add a bullet to the Follow-ups section, phrased as an action item.',
      target: { description: 'under the "## 5. Follow-ups" heading', heading: '5. Follow-ups' },
      verbatim: 'send the deck to finance',
      constraints: ['match the existing bullet style'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'add_text',
  },
  {
    id: 'F05',
    label: 'edit · rename title (QA 20)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'Rename the title to Q3 Review Final',
    directive: {
      task: 'edit',
      instruction: 'Rename the note title — the top-level H1 heading — to "Q3 Review Final".',
      target: { description: 'line 1, the H1 heading at the top of the note', heading: null },
      verbatim: null,
      constraints: ['change only the title line'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'edit_text',
  },
  {
    id: 'F06',
    label: 'remove · API keys bullet, filler-prefixed (QA 21)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'um, please delete the bullet about API keys',
    directive: {
      task: 'remove',
      instruction: 'Delete the Security bullet about rotating production API keys.',
      target: { description: 'the first bullet under "## 6. Security"', heading: '6. Security' },
      verbatim: null,
      constraints: ['keep the SSO audit bullet'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'remove_text',
  },
  {
    id: 'F07',
    label: 'extract · LTV/CAC formula into Revenue (QA 9, D2 frame_extract)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'pull the LTV/CAC formula from the slide into Revenue',
    directive: {
      task: 'extract',
      instruction:
        'Pull the LTV/CAC north-star formula from the live slide into the Revenue section of the note. The supervising model read the frame; its extracted content is in frame_extract below — place that content under the Revenue heading as a LaTeX block.',
      target: { description: 'under the "## 2. Revenue" heading', heading: '2. Revenue' },
      verbatim: null,
      constraints: ['latex block', 'do not alter the Revenue table'],
      frame_extract: FRAME_EXTRACT_FORMULA,
      frame_relevant: true,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'extract_visual_to_note',
  },
  {
    id: 'F08',
    label: 'create · README template at top of seed note (design §13.1)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'write a README template document to begin',
    directive: {
      task: 'create',
      instruction:
        'Write a README template document to begin the note: title it README and give it the standard sections — overview, getting started, usage, contributing, license. The note currently holds a Q3 review; the user wants the template at the top.',
      target: { description: 'top of the note, before the "# Q3 Business Review" heading', heading: null },
      verbatim: null,
      constraints: ['markdown', 'keep the existing Q3 content intact'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'add_text',
    recordContent: 'README (seed note)',
  },
  {
    id: 'F09',
    label: 'create · README template on bare # Untitled note (design §13.1)',
    noteName: 'untitled',
    note: () => UNTITLED_NOTE,
    userCommand: 'write a README template document to begin',
    directive: {
      task: 'create',
      instruction:
        'Write a README template document to begin the note: title it README and give it the standard sections — overview, getting started, usage, contributing, license. The note is a brand-new note holding only the placeholder heading "# Untitled"; the README becomes the note\'s opening content.',
      target: { description: 'the note, starting at the top', heading: null },
      verbatim: null,
      constraints: ['markdown'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'add_text',
    recordContent: 'README (untitled note)',
  },
  {
    id: 'F10',
    label: 'edit · follow-up "do the same for Q4" (design §13.2, 3-turn packet)',
    noteName: 'followup',
    note: () => FOLLOWUP_NOTE,
    userCommand: 'do the same for Q4 to $1.5M',
    directive: {
      task: 'edit',
      instruction:
        'Do the same for Q4: update the Q4 revenue row in the Revenue table to $1.5M and Status Final, mirroring the Q3 row update from the previous turn (value plus Status column).',
      target: { description: 'the Q4 row of the Revenue table', heading: '2. Revenue' },
      verbatim: null,
      constraints: ['only the Q4 row changes'],
      frame_relevant: false,
    },
    contextPacket: FOLLOWUP_PACKET,
    expectedTool: 'edit_text',
  },
  {
    id: 'F11',
    label: 'remove · vague "that section about API keys" (QA 23 shape)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'remove that section about API keys',
    directive: {
      task: 'remove',
      instruction:
        'Remove the section about API keys — the "## 6. Security" section at the end of the note: its heading and its two bullets (rotating production API keys, completing the SSO audit).',
      target: { description: 'the whole "## 6. Security" section at the end of the note', heading: '6. Security' },
      verbatim: null,
      constraints: ['nothing outside the Security section is touched'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'remove_text',
  },
  {
    id: 'F12',
    label: 'insert · fourth risk in Risks list (authoring probe)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'add a fourth risk about vendor concentration to the Risks list',
    directive: {
      task: 'insert',
      instruction:
        'Add a fourth numbered risk about vendor concentration to the "## 4. Risks" list, matching the existing "1. / 2. / 3." numbered style.',
      target: { description: 'the numbered list under "## 4. Risks"', heading: '4. Risks' },
      verbatim: null,
      constraints: ['numbered list item', 'keep risks 1–3 unchanged'],
      frame_relevant: false,
    },
    contextPacket: EMPTY_PACKET,
    expectedTool: 'add_text',
  },
]

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

function scoreAttempt(completion, note) {
  const parse = scoreParse(completion.text, completion.reasoning)
  const params = parse.ok ? scoreParams(parse.parsed) : { ok: false, problems: ['no parsed call'] }
  const grounding = parse.ok ? scoreGrounding(parse.parsed, note) : { ok: false, detail: 'no parsed call' }
  return {
    parse,
    params,
    grounding,
    fullValid: parse.ok && params.ok && grounding.ok,
  }
}

async function main() {
  console.log(`E4 worker authoring spike — ${SERVER} (${MODEL_ALIAS})`)

  const health = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  if (!health || health.status !== 'ok') {
    console.error(`Worker server not healthy at ${SERVER}/health: ${JSON.stringify(health)}`)
    process.exit(1)
  }
  console.log(`health: ${health.status}`)

  const results = []
  for (const fixture of FIXTURES) {
    const note = fixture.note()
    const baseMessages = [
      { role: 'system', content: WORKER_SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(fixture) },
    ]

    console.log(`\n[${fixture.id}] ${fixture.label}`)

    const attempt1 = await chatComplete(baseMessages, ATTEMPT1, `${fixture.id} attempt 1`)
    await sleep(INTER_REQUEST_DELAY_MS)
    const score1 = scoreAttempt(attempt1, note)
    const record = {
      id: fixture.id,
      label: fixture.label,
      noteName: fixture.noteName,
      noteLineCount: splitLines(note).length,
      userCommand: fixture.userCommand,
      directive: fixture.directive,
      expectedTool: fixture.expectedTool,
      contextPacketTurns: fixture.contextPacket.length,
      promptChars: baseMessages[1].content.length,
      attempts: [],
      firstTryFullValid: score1.fullValid && attempt1.ok && !attempt1.error,
      validAfterRetry: null,
      retryRecovered: null,
    }

    const snapshot = (label, completion, score) => ({
      attempt: label,
      requestOk: completion.ok,
      error: completion.error,
      latencyMs: completion.ms,
      promptTokens: completion.promptTokens ?? null,
      outputTokens: completion.outputTokens ?? null,
      rawOutput: completion.ok ? (completion.text || completion.reasoning) : '',
      reasoningSeparated: Boolean(completion.ok && completion.reasoning && !/<think>/.test(completion.text)),
      toolCallBlockCount: score.parse.callCount,
      parseOk: score.parse.ok,
      parsedTool: score.parse.ok ? score.parse.parsed.name : null,
      parsedParams: score.parse.ok ? score.parse.parsed.params : null,
      toolMatchesDirectiveExpectation:
        score.parse.ok ? score.parse.parsed.name === fixture.expectedTool : null,
      paramsOk: score.params.ok,
      paramsProblems: score.params.problems ?? [],
      groundingOk: score.grounding.ok,
      groundingDetail: score.grounding.detail ?? '',
      groundingBoundsOk: score.grounding.boundsOk ?? null,
      anchorOk: score.grounding.anchorOk ?? null,
      blastRadiusOk: score.grounding.blastRadiusOk ?? null,
      blastRadiusNote: score.grounding.blastNote ?? '',
      fullValid: score.fullValid && completion.ok && !completion.error,
    })

    record.attempts.push(snapshot('attempt-1', attempt1, score1))
    console.log(
      `  attempt-1: ${attempt1.ms} ms · parse=${score1.parse.ok} params=${score1.params.ok} anchor=${score1.grounding.ok}` +
        (score1.parse.ok ? ` tool=${score1.parse.parsed.name}` : '') +
        (attempt1.error ? ` ERROR:${attempt1.error}` : ''),
    )

    if (!record.firstTryFullValid) {
      // P3 retry policy: exactly one retry, error appended to the conversation.
      const assistantTurn = (attempt1.text || attempt1.reasoning || '(empty reply)').slice(0, 8000)
      const retryMessages = [
        ...baseMessages,
        { role: 'assistant', content: assistantTurn },
        { role: 'user', content: retryErrorMessage(score1.parse, score1.params, score1.grounding) },
      ]
      const attempt2 = await chatComplete(retryMessages, RETRY, `${fixture.id} retry`)
      await sleep(INTER_REQUEST_DELAY_MS)
      const score2 = scoreAttempt(attempt2, note)
      record.attempts.push(snapshot('retry', attempt2, score2))
      record.validAfterRetry = score2.fullValid && attempt2.ok && !attempt2.error
      record.retryRecovered = record.validAfterRetry
      console.log(
        `  retry:    ${attempt2.ms} ms · parse=${score2.parse.ok} params=${score2.params.ok} anchor=${score2.grounding.ok} → ` +
          (record.validAfterRetry ? 'RECOVERED' : 'still invalid'),
      )
    } else {
      console.log('  first-try fully valid — no retry needed')
    }

    if (fixture.recordContent) {
      // README fixtures: record the authored content VERBATIM for human
      // judgment. Prefer the first valid attempt; fall back to the last
      // parsed attempt, flagged as coming from an invalid one.
      const valid = record.attempts.filter((a) => a.fullValid && a.parseOk).at(-1)
      const source = valid ?? record.attempts.filter((a) => a.parseOk).at(-1) ?? null
      record.readmeSample = {
        fromFixtureLabel: fixture.label,
        fromAttempt: source ? source.attempt : null,
        fromValidAttempt: Boolean(valid),
        tool: source?.parsedTool ?? null,
        content:
          source?.parsedTool === 'add_text'
            ? (source.parsedParams.content ?? null)
            : source?.parsedTool === 'edit_text'
              ? (source.parsedParams.new_text ?? null)
              : null,
      }
    }

    results.push(record)
  }

  // ---------------------------------------------------------------- summary
  const total = results.length
  const firstTryParse = results.filter((r) => r.attempts[0].parseOk).length
  const firstTryParams = results.filter((r) => r.attempts[0].parseOk && r.attempts[0].paramsOk).length
  const firstTryAnchor = results.filter((r) => r.attempts[0].parseOk && r.attempts[0].groundingOk).length
  const firstTryFull = results.filter((r) => r.firstTryFullValid).length
  const retried = results.filter((r) => r.attempts.length > 1)
  const recovered = results.filter((r) => r.retryRecovered)
  const firstTryLatencies = results.map((r) => r.attempts[0].latencyMs).sort((a, b) => a - b)
  const allLatencies = results.flatMap((r) => r.attempts.map((a) => a.latencyMs)).sort((a, b) => a - b)
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`
  const pick = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))]

  const summary = {
    fixtures: total,
    passBar: '85% of fixtures fully valid (parse + params + anchor) first-try',
    firstTry: {
      parseOk: firstTryParse,
      parseRate: pct(firstTryParse),
      paramsOk: firstTryParams,
      paramsRate: pct(firstTryParams),
      anchorOk: firstTryAnchor,
      anchorRate: pct(firstTryAnchor),
      fullyValid: firstTryFull,
      fullyValidRate: pct(firstTryFull),
      passBarMet: firstTryFull / total >= 0.85,
    },
    retry: {
      fixturesRetried: retried.length,
      recovered: recovered.length,
      recoveryRate: retried.length
        ? `${((recovered.length / retried.length) * 100).toFixed(1)}%`
        : 'n/a (nothing to retry)',
      validAfterRetry: results.filter((r) => r.firstTryFullValid || r.validAfterRetry).length,
    },
    latencyMs: {
      firstTry: {
        min: firstTryLatencies[0],
        median: pick(firstTryLatencies, 0.5),
        max: firstTryLatencies[firstTryLatencies.length - 1],
      },
      allAttempts: {
        min: allLatencies[0],
        median: pick(allLatencies, 0.5),
        max: allLatencies[allLatencies.length - 1],
      },
    },
    promptTokens: {
      note: 'llama.cpp-reported prompt tokens per attempt, when the server reports usage',
      firstTry: results.map((r) => ({ id: r.id, promptTokens: r.attempts[0].promptTokens })),
    },
  }

  const output = {
    spike: 'E4 — worker authoring capability (architecture-refactor.md §4, design.md §6 packet)',
    at: new Date().toISOString(),
    server: { url: SERVER, modelAlias: MODEL_ALIAS, health: health.status },
    sampler: { attempt1: ATTEMPT1, retry: RETRY, note: 'retry = P3 policy (error appended) with the repo attempt-2 temperature bump' },
    promptDesign: {
      system: 'author the content, ground own span (line numbers + exact anchor from the note), exactly one XML tool call in the repo contract (worker.ts renderToolCallXml syntax; xml.ts parser applies)',
      user: 'typed directive (design.md §5 JSON) + context packet (last 3 completed edit turns as {user command, directive summary, diff summary}) + FULL line-numbered note + all 4 tool schemas (repo TOOL_DEFS rendering)',
      duplicatedRules: [
        'src/lib/xml.ts parseToolCallXml + KNOWN_TOOLS',
        'src/lib/doc.ts splitLines/normalizeWhitespace/parseHeading/getHeadings/findHeading',
        'src/lib/tools.ts removalCapFor + EDIT_RETENTION_RATIO (informational blast radius)',
        'src/data/tools.ts TOOL_DEFS',
        'src/data/note.ts NOTE_PATH + INITIAL_NOTE',
        'src/data/scene.ts VISUAL_MARKDOWN.formula (frame_extract payload)',
      ],
    },
    scoring: {
      parse: 'parseToolCallXml returns a known-tool call (repo parser, tolerant of surrounding text)',
      params: 'all required params present, non-empty, correctly typed (integers, position enum) per TOOL_DEFS + executeTool guards',
      anchor: 'edit/remove: 1<=start<=end<=lineCount AND whitespace-normalized anchor == note lines at range; add/extract: position enum resolvable against the note (heading exists / line in bounds)',
      fullValid: 'parse AND params AND anchor on the same attempt',
    },
    summary,
    fixtures: results,
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const outDir = path.resolve(here, '..', 'docs', 'spikes')
  mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'E4-worker-authoring.json')
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n')

  console.log('\n================ E4 SUMMARY ================')
  console.log(`fixtures: ${total}`)
  console.log(`first-try parse : ${firstTryParse}/${total} (${pct(firstTryParse)})`)
  console.log(`first-try params: ${firstTryParams}/${total} (${pct(firstTryParams)})`)
  console.log(`first-try anchor: ${firstTryAnchor}/${total} (${pct(firstTryAnchor)})`)
  console.log(`first-try FULL  : ${firstTryFull}/${total} (${pct(firstTryFull)}) — bar 85% → ${summary.firstTry.passBarMet ? 'MET' : 'NOT MET'}`)
  console.log(`retried: ${retried.length} · recovered: ${recovered.length} (rate ${summary.retry.recoveryRate})`)
  console.log(`valid after retry policy: ${summary.retry.validAfterRetry}/${total}`)
  console.log(
    `latency first-try: min ${summary.latencyMs.firstTry.min} ms · median ${summary.latencyMs.firstTry.median} ms · max ${summary.latencyMs.firstTry.max} ms`,
  )
  console.log(`raw results: ${outPath}`)
}

main().catch((err) => {
  console.error('SPIKE ERROR:', err?.stack ?? err)
  process.exit(1)
})
