#!/usr/bin/env node
/**
 * Live front-door check: the E1 turn set through the REAL runOmniTurn.
 *
 * QA-gate follow-up (15/35): the battery showed directive-speak in chat
 * replies (case 2/3) and mutation turns answered instead of delegated
 * (cases 7/8/9/21). This harness makes prompt/pipeline iterations measurable
 * against the live LFM3-Omni-2B at http://127.0.0.1:8083 — the same 20 turns
 * as docs/spikes/E1-omni-directive.md (verbatim, imported from the E1 spike
 * script so they cannot drift), one rolling conversation, note frozen at the
 * seed note (no worker in the harness — same policy as E1).
 *
 * What is under test is the REAL code: src/lib/omni.ts is compiled with the
 * repo's own tsc into a tmp dir (the scripts/spike-worker-packet-check.mjs
 * pattern) and imported, so the system prompt, tool definitions, message
 * assembly, sanitizer, repair/clarify flow and streaming plumbing under
 * measurement are byte-for-byte the code that ships. The ONLY piece
 * duplicated is the SSE loop of bridge.ts's chatCompleteStream (bridge lives
 * in the browser; runOmniTurn accepts an injectable chat fn, and the
 * injection point is exercised on purpose) — it mirrors bridge.ts chunk for
 * chunk: delta.content → onToken, delta.tool_calls accumulated per index.
 *
 * Scoring (per turn):
 *   answer   expected: outcome answer, no tool call, and a CLEAN reply — no
 *            directive-speak (bold directive field labels, directive JSON
 *            keys, delegation/tool/pipeline/worker vocabulary). T01 ("hey")
 *            additionally must not describe the note unasked (battery case 2).
 *   clarify  expected: outcome clarify, or an answer that is a question —
 *            the E1 bar was "never delegate a guess"; a model-authored
 *            question in either channel meets it. A delegation = FAIL.
 *   delegate expected: outcome delegate, task tag == expected task, and the
 *            E1 mustMention regexes present in instruction+verbatim+
 *            constraints (the "brief carries everything" bar). T12 also
 *            requires frame_relevant=true.
 *   action   expected: outcome action with the expected undo/redo.
 *
 * Streaming evidence: every turn records how many times onText fired and the
 * provisional-vs-authoritative text. The STREAM row (a long-answer turn, not
 * part of the E1 score) asserts onText fires >= 3 times for an answer — the
 * shipped live-streaming feature the omni-first branch regressed (case 18).
 *
 * Usage: node scripts/omni-live-check.mjs [--label baseline]
 * Exit code 1 if any E1 turn fails (the STREAM row warns but does not gate
 * the exit code on the baseline contract — it gates on the final one, >= 3).
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

const SERVER = process.env.OMNI_SERVER ?? 'http://127.0.0.1:8083'
const MODEL_ALIAS = 'lfm3-omni-2b'
const REQUEST_TIMEOUT_MS = 120_000
const INTER_REQUEST_DELAY_MS = 250

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const LABEL = flag('--label', `run-${new Date().toISOString()}`)

// --------------------------------------------------------------------------
// Compile the REAL src/lib/omni.ts (plus its import graph: bridge, directive,
// utils, data/note, types) with the repo tsc, as in spike-worker-packet-check.
// --------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const srcRoot = path.join(repoRoot, 'src')
const buildDir = path.join(
  tmpdir(),
  `live-edit-omni-live-check-${createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)}`,
)

function compileRealModules() {
  const modules = ['lib/omni', 'lib/directive', 'lib/utils', 'data/note']
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
  return { omni: compiled('lib/omni'), dataNote: compiled('data/note') }
}

const { omni, dataNote } = compileRealModules()
const { runOmniTurn } = omni
const { INITIAL_NOTE } = dataNote

// E1's 20 turns + the frame renderer, imported from the spike script itself
// (it has a main-guard; importing runs nothing).
const { TURNS, buildFrameDataUrl } = await import(pathToFileURL(path.join(here, 'spike-omni-directive.mjs')).href)

// --------------------------------------------------------------------------
// The one duplicated piece: bridge.ts's streamed chat loop, in Node. Mirrors
// chatCompleteStream chunk for chunk (delta.content → onToken; tool_call
// fragments accumulated per index, assembled at stream end).
// --------------------------------------------------------------------------
async function liveChat(messages, options = {}) {
  const started = performance.now()
  const response = await fetch(`${SERVER}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ALIAS,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 700,
      ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}),
      stream: true,
    }),
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${(detail || response.statusText).slice(0, 240)}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let usage = { promptTokens: 0, outputTokens: 0 }
  let finishReason = null
  const toolCallSlots = new Map()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      if (data === '[DONE]') break
      let chunk
      try { chunk = JSON.parse(data) } catch { continue }
      if (chunk && typeof chunk === 'object' && chunk.usage && typeof chunk.usage === 'object') {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }
      const first = Array.isArray(chunk?.choices) && chunk.choices[0] ? chunk.choices[0] : {}
      if (first.finish_reason) finishReason = first.finish_reason
      const delta = first.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        options.onToken?.(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const entry of delta.tool_calls) {
          if (!entry || typeof entry !== 'object') continue
          const index = typeof entry.index === 'number' ? entry.index : 0
          const slot = toolCallSlots.get(index) ?? { id: '', name: '', arguments: '' }
          if (entry.id) slot.id = entry.id
          if (entry.function?.name) slot.name += entry.function.name
          if (entry.function?.arguments) slot.arguments += entry.function.arguments
          toolCallSlots.set(index, slot)
        }
      }
    }
  }
  await reader.cancel().catch(() => {})
  const toolCalls = [...toolCallSlots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot], position) => ({
      id: slot.id || `call-${position + 1}`,
      type: 'function',
      function: { name: slot.name, arguments: slot.arguments },
    }))
    .filter((call) => call.function.name)
  return {
    text: text.trim(),
    reasoning: '',
    ms: Number((performance.now() - started).toFixed(1)),
    usage,
    toolCalls,
    finishReason,
  }
}

// --------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------

/** Directive-speak / machinery vocabulary that must not appear in a reply. */
const DIRECTIVE_SPEAK =
  /\*\*\s*(task|instruction|target|verbatim|constraints|frame[_ ]?relevant)\s*\*\*|"(task|instruction|verbatim|constraints|frame_relevant)"\s*:|\b(delegat\w*|tool[ _-]?calls?|pipeline|worker|harness|directive|schema)\b/i

function scoreTurn(turn, outcome) {
  const problems = []
  if (turn.expect === 'answer') {
    if (outcome.result?.outcome !== 'answer') {
      problems.push(`expected answer, got ${outcome.result ? outcome.result.outcome : outcome.error}`)
      return { pass: false, problems }
    }
    const speakHits = [...outcome.result.text.matchAll(new RegExp(DIRECTIVE_SPEAK.source, 'gi'))].map(
      (match) => match[0],
    )
    for (const hit of speakHits) {
      problems.push(`directive-speak "${hit}"`)
    }
    if (turn.id === 'T01' && /revenue|pending|slide|note\b/i.test(outcome.result.text)) {
      problems.push('greeting describes the note/frame unasked')
    }
    return { pass: problems.length === 0, problems }
  }
  if (turn.expect === 'clarify') {
    // The E1 bar: never delegate a guess. A model-authored question — via the
    // clarify path OR as a plain answer — meets it.
    const result = outcome.result
    if (result?.outcome === 'clarify') return { pass: true, problems }
    if (result?.outcome === 'answer' && result.text.includes('?')) return { pass: true, problems }
    problems.push(
      result?.outcome === 'delegate'
        ? `delegated a guess (task ${result.directive?.task})`
        : `expected a clarifying question, got ${result ? result.outcome : outcome.error}`,
    )
    return { pass: false, problems }
  }
  if (turn.expect === 'action') {
    if (outcome.result?.outcome !== 'action') {
      problems.push(`expected action, got ${outcome.result ? outcome.result.outcome : outcome.error}`)
      return { pass: false, problems }
    }
    if (outcome.result.action !== turn.action) problems.push(`action ${outcome.result.action} != ${turn.action}`)
    return { pass: problems.length === 0, problems }
  }
  // delegate
  const result = outcome.result
  if (result?.outcome !== 'delegate') {
    problems.push(`expected delegate, got ${result ? result.outcome : outcome.error}`)
    if (result?.outcome === 'answer') problems.push(`(answered instead: "${result.text.slice(0, 90)}")`)
    return { pass: false, problems }
  }
  const directive = result.directive
  if (turn.task && directive.task !== turn.task) {
    problems.push(`task ${directive.task} != ${turn.task}`)
  }
  const corpus = [
    directive.instruction,
    directive.verbatim ?? '',
    Array.isArray(directive.constraints) ? directive.constraints.join(' ') : '',
  ].join(' \n ')
  for (const regex of turn.mustMention ?? []) {
    if (!regex.test(corpus)) problems.push(`brief misses ${regex}`)
  }
  if (turn.frameRequired && directive.frame_relevant !== true) problems.push('frame_relevant not true')
  return { pass: problems.length === 0, problems }
}

// --------------------------------------------------------------------------
// The rolling conversation (E1 run-3 history policy, via runOmniTurn's own
// OmniHistoryTurn shape: model replies as text, delegations as tool records,
// failed turns add no assistant message). Note frozen at the seed note.
// --------------------------------------------------------------------------

const FRAME = { source: 'synthetic-slide', dataUrl: buildFrameDataUrl() }
const STREAM_TURN = {
  id: 'STREAM',
  text: 'tell me a story about a lighthouse, three paragraphs',
  expect: 'answer',
  streamOnly: true,
}

async function runTurn(turn, history, deltas) {
  deltas.length = 0
  try {
    const result = await runOmniTurn({
      command: turn.text,
      source: 'text',
      history: [...history],
      note: INITIAL_NOTE,
      frame: turn.frame ? FRAME : null,
      lastRun: null,
      onText: (delta) => deltas.push(delta),
      chat: liveChat,
    })
    return { result, error: null }
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function historyEntryFor(turn, outcome) {
  const result = outcome.result
  if (!result) return { command: turn.text } // failed turn: no assistant message
  if (result.outcome === 'answer' || result.outcome === 'clarify') {
    return { command: turn.text, reply: result.text }
  }
  if (result.outcome === 'action') {
    return {
      command: turn.text,
      delegation: { tool: 'harness_action', arguments: JSON.stringify({ action: result.action }), result: 'Executed' },
    }
  }
  return {
    command: turn.text,
    delegation: { tool: 'delegate_edit', arguments: JSON.stringify(result.directive), result: 'Executed' },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const health = await fetch(`${SERVER}/health`).catch(() => null)
  if (!health?.ok) {
    console.error(`Omni endpoint not healthy at ${SERVER} (start it first: scripts/start-models.sh)`)
    process.exit(2)
  }

  console.log(`omni-live-check · label=${LABEL} · server=${SERVER} · note frozen at seed (${INITIAL_NOTE.length} chars)`)
  const rows = []
  const history = []
  const deltas = []

  for (const turn of [...TURNS, STREAM_TURN]) {
    const outcome = await runTurn(turn, history, deltas)
    const joined = deltas.join('')
    const scored = turn.streamOnly
      ? {
          pass: outcome.result?.outcome === 'answer' && deltas.length >= 3,
          problems: [
            ...(outcome.result?.outcome === 'answer' ? [] : [`outcome ${outcome.result?.outcome ?? outcome.error}`]),
            ...(deltas.length >= 3 ? [] : [`onText fired ${deltas.length}x (want >=3)`]),
          ],
        }
      : scoreTurn(turn, outcome)
    history.push(historyEntryFor(turn, outcome))

    const got = outcome.result
      ? outcome.result.outcome === 'delegate'
        ? `delegate/${outcome.result.directive.task}`
        : outcome.result.outcome
      : `ERROR(${outcome.error.slice(0, 60)})`
    const brief = outcome.result?.directive
      ? `"${outcome.result.directive.instruction.slice(0, 110)}"`
      : outcome.result?.text
        ? `"${outcome.result.text.slice(0, 110).replace(/\n/g, ' ')}"`
        : ''
    rows.push({
      id: turn.id,
      text: turn.text,
      expect: turn.streamOnly ? 'answer(stream)' : `${turn.expect}${turn.task ? `/${turn.task}` : ''}`,
      got,
      pass: scored.pass,
      problems: scored.problems,
      onTextCalls: deltas.length,
      provisionalChars: joined.length,
      authoritativeChars: outcome.result?.text?.length ?? 0,
      ms: outcome.result?.ms ?? null,
      brief,
      // Repair diagnostics (validation error + raw emitted arguments) —
      // the evidence for the repair-failure clarify class.
      repair: outcome.result?.repair ?? null,
    })
    console.log(
      `  ${scored.pass ? 'PASS' : 'FAIL'}  ${turn.id.padEnd(6)} expect=${(turn.streamOnly ? 'answer(stream)' : turn.expect + (turn.task ? '/' + turn.task : '')).padEnd(15)} got=${got.padEnd(16)} onText=${String(deltas.length).padStart(3)}x  ${scored.problems.join('; ') || brief.slice(0, 100)}`,
    )
    await sleep(INTER_REQUEST_DELAY_MS)
  }

  const e1Rows = rows.filter((row) => !row.id.startsWith('STREAM'))
  const failed = e1Rows.filter((row) => !row.pass)
  const streamRow = rows.find((row) => row.id === 'STREAM')
  const wrongOutcome = e1Rows.filter((row) => {
    const expected = row.expect.split('/')[0]
    if (expected === 'clarify') return row.got.startsWith('delegate') // delegated a guess
    return !row.got.startsWith(expected)
  })
  const bar = ['T01', 'T08', 'T11', 'T12', 'T17']
  const barRows = bar.map((id) => e1Rows.find((row) => row.id === id))

  console.log('\n---- summary ----')
  console.log(`E1 turns: ${e1Rows.length - failed.length}/${e1Rows.length} pass · wrong-outcome: ${wrongOutcome.length}`)
  console.log(`battery bar (hey T01, Redis T08, Security T11, LTV T12, API keys T17): ${barRows.filter((r) => r?.pass).length}/5`)
  for (const row of barRows.filter((r) => r && !r.pass)) {
    console.log(`  bar miss ${row.id}: ${row.problems.join('; ')}`)
  }
  for (const row of e1Rows.filter((r) => r.repair)) {
    console.log(
      `  repair ${row.id}: ${row.repair.error} · raw=${JSON.stringify(row.repair.rawArguments.slice(0, 220))}`,
    )
  }
  console.log(
    `streaming: answer onText fired ${streamRow.onTextCalls}x (${streamRow.provisionalChars} provisional chars, ${streamRow.authoritativeChars} authoritative) — ${streamRow.pass ? 'live' : 'NOT live'}`,
  )

  const outPath = path.join(repoRoot, '.omni-live-check-last.json')
  writeFileSync(outPath, JSON.stringify({ label: LABEL, at: new Date().toISOString(), rows }, null, 1))
  console.log(`wrote ${outPath}`)

  if (failed.length > 0 || !streamRow.pass) process.exit(1)
}

main().catch((error) => {
  console.error('omni-live-check failed:', error?.stack ?? error)
  process.exit(2)
})
