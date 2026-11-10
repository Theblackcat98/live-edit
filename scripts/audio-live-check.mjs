#!/usr/bin/env node
/**
 * Audio-front-door live check: E1's 20-turn set through the REAL runOmniTurn,
 * pointed at LFM3-Audio-2B (:8086) instead of LFM3-Omni-2B (:8083).
 *
 * Same design as scripts/omni-live-check.mjs: compile src/lib/omni.ts with the
 * repo tsc, import TURNS + frame renderer from the E1 spike script, one
 * rolling conversation, note frozen at seed. Only the server/alias differ.
 *
 * Audio model has no vision encoder: frame-bearing turns (T02, T12) go out as
 * text-only on :8086 (frame description + note context, no image_url) — the
 * honest audio-text-front-door shape. Scored identically; T02/T12 frame
 * expectations are flagged FRAME-SKIPPED in problems when they fail for lack
 * of vision rather than judgment.
 *
 * Usage: node scripts/audio-live-check.mjs [--label audio-baseline]
 * Exit code 1 if any E1 turn fails.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

const SERVER = process.env.AUDIO_SERVER ?? 'http://127.0.0.1:8086'
const MODEL_ALIAS = 'lfm3-audio-2b'
const REQUEST_TIMEOUT_MS = 180_000
const INTER_REQUEST_DELAY_MS = 250

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const LABEL = flag('--label', `audio-run-${new Date().toISOString()}`)

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const srcRoot = path.join(repoRoot, 'src')
const buildDir = path.join(
  tmpdir(),
  `live-edit-audio-live-check-${createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)}`,
)

function compileRealModules() {
  const modules = ['lib/omni', 'lib/directive', 'lib/utils', 'data/note']
  const entry = modules.map((m) => `export * from '${path.join(srcRoot, m)}'`).join('\n')
  const entryPath = path.join(buildDir, 'entry.ts')
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(entryPath, entry)
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

const { TURNS, buildFrameDataUrl } = await import(pathToFileURL(path.join(here, 'spike-omni-directive.mjs')).href)

// Same streamed-chat mirror as omni-live-check (bridge.ts chunk semantics),
// pointed at the audio member. Audio has no vision: image_url parts are
// dropped before sending (text context still carries the frame description).
async function liveChatAudio(messages, options = {}) {
  const stripped = messages.map((m) => {
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      return { ...m, content: text }
    }
    return m
  })
  const started = performance.now()
  const response = await fetch(`${SERVER}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ALIAS,
      messages: stripped,
      temperature: options.temperature ?? 0.3,
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
  let reasoning = ''
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
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content
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
    reasoning,
    ms: Number((performance.now() - started).toFixed(1)),
    usage,
    toolCalls,
    finishReason,
  }
}

const DIRECTIVE_SPEAK =
  /\*\*\s*(task|instruction|target|verbatim|constraints|frame[_ ]?relevant)\s*\*\*|"(task|instruction|verbatim|constraints|frame_relevant)"\s*:|\b(delegat\w*|tool[ _-]?calls?|pipeline|worker|harness|directive|schema)\b/i

function scoreTurn(turn, outcome) {
  const problems = []
  if (turn.expect === 'answer') {
    if (outcome.result?.outcome !== 'answer') {
      problems.push(`expected answer, got ${outcome.result ? outcome.result.outcome : outcome.error}`)
      if (turn.frame) problems.push('FRAME-SKIPPED(no-vision)')
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
  const result = outcome.result
  if (result?.outcome !== 'delegate') {
    problems.push(`expected delegate, got ${result ? result.outcome : outcome.error}`)
    if (result?.outcome === 'answer') problems.push(`(answered instead: "${result.text.slice(0, 90)}")`)
    if (turn.frame) problems.push('FRAME-SKIPPED(no-vision)')
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
      chat: liveChatAudio,
    })
    return { result, error: null }
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function historyEntryFor(turn, outcome) {
  const result = outcome.result
  if (!result) return { command: turn.text }
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
    console.error(`Audio endpoint not healthy at ${SERVER} (start it first)`)
    process.exit(2)
  }

  console.log(`audio-live-check · label=${LABEL} · server=${SERVER} (${MODEL_ALIAS}) · note frozen at seed (${INITIAL_NOTE.length} chars) · frames text-only (no vision)`)
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
    if (expected === 'clarify') return row.got.startsWith('delegate')
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

  const outPath = path.join(repoRoot, '.audio-live-check-last.json')
  writeFileSync(outPath, JSON.stringify({ label: LABEL, at: new Date().toISOString(), rows }, null, 1))
  console.log(`wrote ${outPath}`)

  if (failed.length > 0 || !streamRow.pass) process.exit(1)
}

main().catch((error) => {
  console.error('audio-live-check failed:', error?.stack ?? error)
  process.exit(2)
})
