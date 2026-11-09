#!/usr/bin/env node
/**
 * Phase-3 validation of the packet-based worker prompt (E4 follow-up).
 *
 * Question: with `buildPacketWorkerMessages` / `buildWorkerRetryMessages` from
 * src/lib/worker.ts (the REAL shipped prompt, compiled — not duplicated), how
 * often does LFM3-1.7B emit a parseable, correctly grounded call on the FIRST
 * attempt across the SAME 12 fixtures E4 scored 41.7% on? Bar: ≥85% (≥10/12).
 *
 * Difference from scripts/spike-worker-authoring.mjs (unmodified, kept): E4
 * duplicated the prompt AND the repo rules in-script because src/ is TypeScript.
 * This script compiles the real src modules to CommonJS with the repo's own
 * `tsc` at startup (into os.tmpdir(), nothing written into the repo) and
 * imports them — the prompt under test is byte-for-byte the code that ships.
 * Compiled imports: worker.ts (packet builders), xml.ts (parseToolCallXml),
 * doc.ts (splitLines/normalizeWhitespace/findHeading), data/tools.ts
 * (TOOL_DEFS), data/note.ts (NOTE_PATH/INITIAL_NOTE), data/scene.ts
 * (VISUAL_MARKDOWN.formula). Only removalCapFor + EDIT_RETENTION_RATIO are
 * duplicated verbatim from src/lib/tools.ts (not exported; informational
 * blast-radius scoring only, exactly as in E4).
 *
 * Scoring is E4's, rule for rule: parse (repo parser) → params (required,
 * non-empty, typed per TOOL_DEFS + executeTool guards) → anchor (bounds +
 * whitespace-normalized equality vs the note) → latency. One retry per
 * failure, driven by buildWorkerRetryMessages with the concrete error
 * (exact parse/gate reason, the note's actual text on an anchor miss, the
 * attempted tool's parameter list).
 *
 * Usage: node scripts/spike-worker-packet-check.mjs [--label v1]
 *        [--max-tokens 3000] [--retry-max-tokens 3000]
 * Sampler otherwise mirrors the shipped worker loop: attempt 1 temp 0.3,
 * retry temp 0.4. Sequential requests, ~250 ms apart, 180 s timeout.
 *
 * Output: appends one iteration record to docs/spikes/E4-packet-iteration.json
 * (created on first run) — every number in docs/spikes/E4-packet-iteration.md
 * comes from that file, which comes from actual runs. No fabricated numbers.
 */

import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

const SERVER = 'http://127.0.0.1:8080'
const MODEL_ALIAS = 'lfm3-1.7b'
const REQUEST_TIMEOUT_MS = 180_000
const INTER_REQUEST_DELAY_MS = 250

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2)
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const LABEL = arg('--label', `run-${new Date().toISOString()}`)
const MAX_TOKENS = Number(arg('--max-tokens', '3000'))
const RETRY_MAX_TOKENS = Number(arg('--retry-max-tokens', String(MAX_TOKENS)))
const ATTEMPT1 = { temperature: 0.3, maxTokens: MAX_TOKENS }
const RETRY = { temperature: 0.4, maxTokens: RETRY_MAX_TOKENS }

// --------------------------------------------------------------------------
// Compile the REAL src modules (see header). tsc emits a CommonJS mirror of
// the import graph under a tmp outDir; internal relative requires resolve
// inside the mirror, so we require the compiled worker.js etc. directly.
// --------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const srcRoot = path.join(repoRoot, 'src')
const buildDir = path.join(tmpdir(), `live-edit-packet-spike-${createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)}`)

function compileRealModules() {
  const modules = ['lib/worker', 'lib/xml', 'lib/doc', 'data/tools', 'data/note', 'data/scene']
  const entry = modules.map((m) => `export * from '${path.join(srcRoot, m)}'`).join('\n')
  const entryPath = path.join(buildDir, 'entry.ts')
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(entryPath, entry)
  rmSync(path.join(buildDir, 'out'), { recursive: true, force: true })
  const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc')
  execFileSync(
    tsc,
    [
      '--ignoreConfig',
      '--module', 'commonjs',
      '--target', 'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
      '--outDir', path.join(buildDir, 'out'),
      entryPath,
    ],
    { stdio: 'pipe' },
  )
  const compiled = (rel) => require(path.join(buildDir, 'out', srcRoot, `${rel}.js`))
  return {
    worker: compiled('lib/worker'),
    xml: compiled('lib/xml'),
    doc: compiled('lib/doc'),
    dataTools: compiled('data/tools'),
    dataNote: compiled('data/note'),
    dataScene: compiled('data/scene'),
  }
}

const { worker, xml, doc, dataTools, dataNote, dataScene } = compileRealModules()
const { buildPacketWorkerMessages, buildWorkerRetryMessages, PACKET_WORKER_SYSTEM_PROMPT, renderPacketToolCatalog } = worker
const { parseToolCallXml } = xml
const { splitLines, normalizeWhitespace, findHeading } = doc
const { TOOL_DEFS } = dataTools
const { NOTE_PATH, INITIAL_NOTE } = dataNote

/** src/lib/tools.ts — duplicated verbatim (not exported; informational only). */
function removalCapFor(lineCount) {
  return Math.max(9, Math.floor(lineCount * 0.5))
}
const EDIT_RETENTION_RATIO = 0.3

const FRAME_EXTRACT_FORMULA = dataScene.VISUAL_MARKDOWN.formula

// The follow-up fixture's note: the seed note after the 3 prior edit turns in
// its context packet actually completed. Built by transformation (E4 method).
const FOLLOWUP_NOTE = (() => {
  const out = []
  for (const line of splitLines(INITIAL_NOTE)) {
    if (line === '# Q3 Business Review') out.push('# Q3 Review Final')
    else if (line === '- Redis cache migration was postponed to Q4.') continue
    else if (line === '| Q3 | $1.2M | Pending |') out.push('| Q3 | $1.45M | Final |')
    else out.push(line)
  }
  return out.join('\n')
})()

const UNTITLED_NOTE = '# Untitled\n'

// --------------------------------------------------------------------------
// Scoring — E4's rules, driven by the compiled repo parser/data.
// --------------------------------------------------------------------------

function scoreParse(text, reasoning) {
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
        ok: false, boundsOk: false, anchorOk: false, start, end,
        detail: `range ${start}–${end} is out of bounds for the ${lines.length}-line note`,
        blastRadiusOk: null,
      }
    }
    const current = lines.slice(start - 1, end).join('\n')
    const anchorKey = parsed.name === 'edit_text' ? 'old_text_anchor' : 'target_excerpt'
    const anchorOk = normalizeWhitespace(current) === normalizeWhitespace(parsed.params[anchorKey] ?? '')
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
      ok: anchorOk, boundsOk: true, anchorOk, start, end, anchorKey, actualText: current,
      detail: anchorOk ? `anchor matches note lines ${start}–${end}` : `anchor mismatch at lines ${start}–${end}`,
      blastRadiusOk, blastNote,
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
        ok: boundsOk, boundsOk, anchorOk: boundsOk,
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

function scoreAttempt(completion, note) {
  const parse = scoreParse(completion.text, completion.reasoning)
  const params = parse.ok ? scoreParams(parse.parsed) : { ok: false, problems: ['no parsed call'] }
  const grounding = parse.ok ? scoreGrounding(parse.parsed, note) : { ok: false, detail: 'no parsed call' }
  return { parse, params, grounding, fullValid: parse.ok && params.ok && grounding.ok }
}

/**
 * Compose the retry inputs for buildWorkerRetryMessages from the first
 * attempt's scores: the exact error (with truncation detail when llama.cpp
 * reports finish_reason=length), the attempted tool, and the note's actual
 * text on an anchor miss. This mirrors what the P3 pipeline will feed.
 */
function retryInputs(fixture, score1, completion1) {
  const note = fixture.note()
  const problems = []
  let attemptedTool = null
  let anchorCorrection = null

  if (!score1.parse.ok) {
    const truncated = completion1.finishReason === 'length' || (completion1.outputTokens ?? 0) >= MAX_TOKENS
    problems.push(
      truncated
        ? `no tool call found in the reply — the reply hit the ${completion1.outputTokens}-token output limit before completing (finish_reason=length). Begin the tool call immediately; keep any thinking under three short lines.`
        : 'no tool call found in the reply. Reply with exactly one complete <tool_call> block.',
    )
  } else {
    attemptedTool = score1.parse.parsed.name
    if (!score1.params.ok) {
      problems.push(`the ${attemptedTool} call has parameter problems: ${score1.params.problems.join('; ')}`)
    }
    if (!score1.grounding.ok) {
      problems.push(`grounding failed: ${score1.grounding.detail}`)
      if (score1.grounding.actualText !== undefined && score1.grounding.boundsOk) {
        anchorCorrection = {
          startLine: score1.grounding.start,
          endLine: score1.grounding.end,
          actualText: score1.grounding.actualText,
        }
      }
    }
  }
  void note
  return { error: problems.join(' '), attemptedTool, anchorCorrection }
}

// --------------------------------------------------------------------------
// Server client (E4's, plus finish_reason capture).
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
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}`, ms, text: '', reasoning: '', finishReason: null }
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
      finishReason: payload?.choices?.[0]?.finish_reason ?? null,
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
      finishReason: null,
    }
  }
}

// --------------------------------------------------------------------------
// Fixtures — E4's 12, verbatim.
// --------------------------------------------------------------------------
const EMPTY_PACKET = { editTurns: [], promptTokens: 0 }

const FOLLOWUP_PACKET = {
  promptTokens: 0,
  editTurns: [
    {
      command: 'Rename the title to Q3 Review Final',
      directiveSummary: 'edit · Replace the H1 title "# Q3 Business Review" (line 1) with "# Q3 Review Final".',
      diffSummary: 'edit_text lines 1–1: "# Q3 Business Review" → "# Q3 Review Final" (applied).',
    },
    {
      command: 'remove the bullet about Redis',
      directiveSummary: 'remove · Delete the Product notes bullet "Redis cache migration was postponed to Q4.".',
      diffSummary: 'remove_text 1 line ("- Redis cache migration was postponed to Q4.") — removed (applied).',
    },
    {
      command: 'update the Q3 revenue row to $1.45M Final',
      directiveSummary: 'edit · In the Revenue table, set the Q3 row to Revenue $1.45M, Status Final.',
      diffSummary: 'edit_text 1 line: "| Q3 | $1.2M | Pending |" → "| Q3 | $1.45M | Final |" (applied).',
    },
  ],
}

const FIXTURES = [
  {
    id: 'F01',
    label: 'edit · Q3 revenue row (QA 6)',
    noteName: 'seed',
    note: () => INITIAL_NOTE,
    userCommand: 'update the Q3 revenue row to $1.45M Final',
    directive: {
      task: 'edit',
      instruction: 'Update the Q3 revenue row in the Revenue table: set Revenue to $1.45M and Status to Final.',
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
async function main() {
  console.log(`E4 packet-check — ${SERVER} (${MODEL_ALIAS}) · label "${LABEL}" · attempt1 ${JSON.stringify(ATTEMPT1)} · retry ${JSON.stringify(RETRY)}`)

  const health = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  if (!health || health.status !== 'ok') {
    console.error(`Worker server not healthy at ${SERVER}/health: ${JSON.stringify(health)}`)
    process.exit(1)
  }
  console.log(`health: ${health.status}`)

  // Prompt fingerprint: the shipped prompt under test, this run.
  const promptFingerprint = createHash('sha256')
    .update(PACKET_WORKER_SYSTEM_PROMPT)
    .update(renderPacketToolCatalog())
    .digest('hex')
    .slice(0, 12)

  const results = []
  for (const fixture of FIXTURES) {
    const note = fixture.note()
    const packetInput = {
      directive: fixture.directive,
      contextPacket: fixture.contextPacket,
      note,
    }
    const baseMessages = buildPacketWorkerMessages(packetInput)

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
      contextPacketTurns: fixture.contextPacket.editTurns.length,
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
      finishReason: completion.finishReason ?? null,
      latencyMs: completion.ms,
      promptTokens: completion.promptTokens ?? null,
      outputTokens: completion.outputTokens ?? null,
      rawOutput: completion.ok ? (completion.text || completion.reasoning) : '',
      reasoningSeparated: Boolean(completion.ok && completion.reasoning && !/<think>/.test(completion.text)),
      toolCallBlockCount: score.parse.callCount,
      parseOk: score.parse.ok,
      parsedTool: score.parse.ok ? score.parse.parsed.name : null,
      parsedParams: score.parse.ok ? score.parse.parsed.params : null,
      toolMatchesDirectiveExpectation: score.parse.ok ? score.parse.parsed.name === fixture.expectedTool : null,
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
        (attempt1.finishReason ? ` finish=${attempt1.finishReason}` : '') +
        (attempt1.error ? ` ERROR:${attempt1.error}` : ''),
    )

    if (!record.firstTryFullValid) {
      const { error, attemptedTool, anchorCorrection } = retryInputs(fixture, score1, attempt1)
      const retryMessages = buildWorkerRetryMessages({
        original: packetInput,
        attemptText: attempt1.text || attempt1.reasoning || '(empty reply)',
        error,
        attemptedTool,
        anchorCorrection,
      })
      const attempt2 = await chatComplete(retryMessages, RETRY, `${fixture.id} retry`)
      await sleep(INTER_REQUEST_DELAY_MS)
      const score2 = scoreAttempt(attempt2, note)
      record.attempts.push(snapshot('retry', attempt2, score2))
      record.retryInputs = { error, attemptedTool }
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
      recoveryRate: retried.length ? `${((recovered.length / retried.length) * 100).toFixed(1)}%` : 'n/a (nothing to retry)',
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

  const iteration = {
    label: LABEL,
    at: new Date().toISOString(),
    promptFingerprint,
    promptSource: 'src/lib/worker.ts buildPacketWorkerMessages + PACKET_WORKER_SYSTEM_PROMPT (compiled+imported, not duplicated)',
    server: { url: SERVER, modelAlias: MODEL_ALIAS, health: health.status },
    sampler: { attempt1: ATTEMPT1, retry: RETRY },
    summary,
    fixtures: results,
  }

  const outDir = path.resolve(here, '..', 'docs', 'spikes')
  mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'E4-packet-iteration.json')
  let existing = { iterations: [] }
  if (existsSync(outPath)) {
    try {
      existing = JSON.parse(readFileSync(outPath, 'utf8'))
      if (!Array.isArray(existing.iterations)) existing = { iterations: [] }
    } catch {
      existing = { iterations: [] }
    }
  }
  existing.iterations.push(iteration)
  writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n')

  console.log('\n================ E4 PACKET-CHECK SUMMARY ================')
  console.log(`label "${LABEL}" · prompt ${promptFingerprint}`)
  console.log(`fixtures: ${total}`)
  console.log(`first-try parse : ${firstTryParse}/${total} (${pct(firstTryParse)})`)
  console.log(`first-try params: ${firstTryParams}/${total} (${pct(firstTryParams)})`)
  console.log(`first-try anchor: ${firstTryAnchor}/${total} (${pct(firstTryAnchor)})`)
  console.log(`first-try FULL  : ${firstTryFull}/${total} (${pct(firstTryFull)}) — bar 85% → ${summary.firstTry.passBarMet ? 'MET' : 'NOT MET'}`)
  console.log(`retried: ${retried.length} · recovered: ${recovered.length} (rate ${summary.retry.recoveryRate})`)
  console.log(`valid after retry policy: ${summary.retry.validAfterRetry}/${total}`)
  console.log(`latency first-try: min ${summary.latencyMs.firstTry.min} ms · median ${summary.latencyMs.firstTry.median} ms · max ${summary.latencyMs.firstTry.max} ms`)
  console.log(`appended iteration to: ${outPath}`)
}

main().catch((err) => {
  console.error('SPIKE ERROR:', err?.stack ?? err)
  process.exit(1)
})
