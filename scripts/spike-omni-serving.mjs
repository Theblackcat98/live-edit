#!/usr/bin/env node
/**
 * E2 — Omni serving/sampling spike (Phase 0, docs/architecture-refactor.md §4,
 * design.md Q3).
 *
 * Question: what serving flags + request parameters make LFM3-Omni-2B good at
 * BOTH conversation and the delegate-or-answer decision?
 *
 * Method: rerun E1's 20 turns (verbatim, same protocol incl. the one-repair
 * rule) using E1's WINNING mechanism — read from docs/spikes/E1-omni-directive.json
 * (rule: prefer any mechanism that met the pass bar, higher valid_total wins,
 * tie goes to native-tools as the design's preferred mechanism) — across
 * temperature 0 / 0.3 / 0.7 × note cap 3,600 chars / full note = 6 configs.
 * The note is the repo's seed note (1,312 chars, embedded in and verified
 * against src/data/note.ts by the E1 script).
 *
 * Also answers the `--reasoning off` question with evidence, not assumption:
 * /props (and /v1/models) are captured, and every completion of this spike is
 * scanned for reasoning artifacts (non-empty reasoning_content, <think> tags).
 *
 * Zero npm dependencies: Node 22 built-ins only. Sequential requests, 250 ms
 * delay, 120 s per-request timeout.
 *
 * Output: docs/spikes/E2-omni-serving.json (raw results; every number in the
 * companion .md comes from it). Run E1 first.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BASE_URL,
  MODEL,
  MAX_TOKENS,
  SEED_NOTE,
  TURNS,
  applyNoteCap,
  runConversation,
  summarize,
} from './spike-omni-directive.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const E1_JSON_PATH = path.join(SCRIPT_DIR, '..', 'docs', 'spikes', 'E1-omni-directive.json')
const OUT_PATH = path.join(SCRIPT_DIR, '..', 'docs', 'spikes', 'E2-omni-serving.json')

const CONFIGS = [
  { id: 't0-cap3600', temperature: 0, noteCap: 3600 },
  { id: 't0-full', temperature: 0, noteCap: null },
  { id: 't0.3-cap3600', temperature: 0.3, noteCap: 3600 },
  { id: 't0.3-full', temperature: 0.3, noteCap: null },
  { id: 't0.7-cap3600', temperature: 0.7, noteCap: 3600 },
  { id: 't0.7-full', temperature: 0.7, noteCap: null },
]

const CHAT_TURN_IDS = TURNS.filter((t) => t.expect === 'answer' || t.expect === 'clarify').map((t) => t.id)

function pickWinnerMechanism(e1) {
  const mechanisms = Object.entries(e1.mechanisms).map(([id, m]) => ({ id, summary: m.summary }))
  const passing = mechanisms.filter((m) => m.summary.pass_bar.met)
  const pool = passing.length ? passing : mechanisms
  pool.sort((a, b) => {
    if (b.summary.valid_total !== a.summary.valid_total) return b.summary.valid_total - a.summary.valid_total
    if (a.summary.wrong_outcome !== b.summary.wrong_outcome) return a.summary.wrong_outcome - b.summary.wrong_outcome
    return a.id === 'native-tools' ? -1 : 1
  })
  return {
    mechanism: pool[0].id,
    pass_bar_met_by_winner: pool[0].summary.pass_bar.met,
    any_mechanism_met_pass_bar: passing.length > 0,
    selection_rule: passing.length
      ? 'among mechanisms meeting the pass bar: highest valid_total; tie -> native-tools'
      : 'NO mechanism met the pass bar; best-of-worst by valid_total then wrong_outcome; tie -> native-tools',
    e1_summaries: Object.fromEntries(mechanisms.map((m) => [m.id, m.summary])),
  }
}

function latencyStats(records) {
  const firstAttemptMs = records.map((r) => r.attempts[0]?.ms ?? null).filter((v) => v != null)
  const allMs = records.flatMap((r) => r.attempts.filter((a) => a.ok).map((a) => a.ms))
  const sorted = [...allMs].sort((a, b) => a - b)
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
  return {
    requests_ok: allMs.length,
    all_requests: { mean_ms: mean(allMs), median_ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0, p95_ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0, max_ms: sorted.length ? sorted[sorted.length - 1] : 0 },
    first_attempts_only: { mean_ms: mean(firstAttemptMs), median_ms: firstAttemptMs.length ? [...firstAttemptMs].sort((a, b) => a - b)[Math.floor(firstAttemptMs.length / 2)] : 0 },
    length_truncations: records.flatMap((r) => r.attempts).filter((a) => a.finishReason === 'length').length,
  }
}

async function main() {
  console.log(`E2 — Omni serving/sampling spike`)
  const health = await fetch(`${BASE_URL}/health`).catch(() => null)
  if (!health?.ok) {
    console.error('server :8083 is down — refusing to run (no fabricated numbers)')
    process.exitCode = 2
    return
  }
  if (!existsSync(E1_JSON_PATH)) {
    console.error(`E1 results missing at ${E1_JSON_PATH} — run spike-omni-directive.mjs first`)
    process.exitCode = 2
    return
  }
  const e1 = JSON.parse(readFileSync(E1_JSON_PATH, 'utf8'))
  const winner = pickWinnerMechanism(e1)
  console.log(`E1 winner mechanism: ${winner.mechanism} (pass bar met: ${winner.pass_bar_met_by_winner})`)

  // --- serving-flag evidence: /props + /v1/models --------------------------
  const props = await fetch(`${BASE_URL}/props`).then((r) => r.json()).catch(() => null)
  const models = await fetch(`${BASE_URL}/v1/models`).then((r) => r.json()).catch(() => null)
  const genParams = props?.default_generation_settings?.params ?? {}
  const serverInfo = {
    base_url: BASE_URL,
    model: MODEL,
    build_info: props?.build_info ?? null,
    served_flags_in_start_models_sh: '--jinja --reasoning off --temp 0 (plus family COMMON_FLAGS)',
    props_default_generation_params: genParams,
    chat_template_caps: props?.chat_template_caps ?? null,
    models_endpoint: models?.data?.map((d) => ({ id: d.id, architecture: d.architecture ?? null })) ?? null,
  }

  // --- 6 configs ------------------------------------------------------------
  const configs = []
  for (const config of CONFIGS) {
    const note = applyNoteCap(SEED_NOTE, config.noteCap)
    console.log(`\n== config ${config.id}: temperature ${config.temperature}, note ${note.shownChars} chars (truncated: ${note.truncated}), max_tokens ${MAX_TOKENS}`)
    const t0 = Date.now()
    const records = await runConversation({
      mechanism: winner.mechanism,
      temperature: config.temperature,
      maxTokens: MAX_TOKENS,
      noteText: note.text,
      onTurn: (r) => console.log(`  ${r.turnId} [${r.finalClass}]${r.reason ? ' — ' + r.reason.slice(0, 80) : ''}`),
    })
    const summary = summarize(records)
    summary.wall_ms = Date.now() - t0
    const chatReplies = records
      .filter((r) => CHAT_TURN_IDS.includes(r.turnId))
      .map((r) => ({ turnId: r.turnId, reply: r.attempts.at(-1)?.content ?? '' }))
    configs.push({
      ...config,
      note_chars_shown: note.shownChars,
      note_truncated: note.truncated,
      max_tokens: MAX_TOKENS,
      summary,
      latency: latencyStats(records),
      chat_replies_verbatim: chatReplies,
      turns: records,
    })
    console.log(`  summary: valid ${summary.valid_total}/20 (first ${summary.valid_first_try} + repaired ${summary.valid_after_repair}) | invalid ${summary.invalid} | wrong-outcome ${summary.wrong_outcome} (${summary.wrong_outcome_ids.join(',') || '-'}) | errors ${summary.error} | destructive WO ${summary.destructive_wrong_outcome_count}`)
    console.log(`  latency: mean ${configs.at(-1).latency.all_requests.mean_ms}ms, p95 ${configs.at(-1).latency.all_requests.p95_ms}ms, truncations ${configs.at(-1).latency.length_truncations}`)
  }

  // --- --reasoning evidence: scan every completion of this run -------------
  let reasoningContentNonEmpty = 0
  let thinkTagsInContent = 0
  let completionsScanned = 0
  for (const c of configs) {
    for (const r of c.turns) {
      for (const a of r.attempts) {
        if (!a.ok) continue
        completionsScanned++
        if (a.reasoningContent && a.reasoningContent.trim()) reasoningContentNonEmpty++
        if (typeof a.content === 'string' && a.content.includes('<think')) thinkTagsInContent++
      }
    }
  }
  const reasoningFlag = {
    flag: '--reasoning off (scripts/start-models.sh, omni member)',
    evidence: [
      `/props default_generation_settings.params.reasoning_format = ${JSON.stringify(genParams.reasoning_format ?? null)}`,
      `/props default_generation_settings.params.reasoning_in_content = ${JSON.stringify(genParams.reasoning_in_content ?? null)}`,
      `live scan of ${completionsScanned} completions in this spike: non-empty reasoning_content = ${reasoningContentNonEmpty}, "<think" in content = ${thinkTagsInContent}`,
      'model card: LFM3-Omni-2B is a non-reasoning model (architecture-refactor.md §4 E2 states the expectation; this run verifies it)',
      'chat_template_caps.supports_reasoning_effort = ' + JSON.stringify(props?.chat_template_caps?.supports_reasoning_effort ?? null) + ' (no effort levels exist for this template)',
    ],
    verdict:
      genParams.reasoning_format === 'none' && reasoningContentNonEmpty === 0 && thinkTagsInContent === 0
        ? 'NO-OP on this build: the model emits no reasoning tokens, so disabling reasoning parsing changes nothing observable. Recommend REMOVE from start-models.sh (dead configuration implies a reasoning capability that does not exist); removing cannot change behaviour.'
        : 'NOT a no-op — reasoning artifacts observed; keep the flag and investigate.',
  }

  // --- note-cap dimension observation ---------------------------------------
  const capNote = {
    seed_note_chars: SEED_NOTE.length,
    cap: 3600,
    cap_truncates_seed_note: SEED_NOTE.length > 3600,
    observation: `The seed note is ${SEED_NOTE.length} chars, below the 3,600-char cap, so cap-3600 and full-note configs received byte-identical note context. The cap dimension is a no-op on THIS note; any difference between paired configs at the same temperature is sampling noise (at temperature 0 it doubles as a determinism check). A cap verdict for longer notes needs a longer-note run — out of this spike's scope, recorded honestly.`,
  }

  // --- determinism check at temperature 0 -----------------------------------
  const t0pair = configs.filter((c) => c.temperature === 0)
  const determinism = t0pair.length === 2
    ? {
        compared: `${t0pair[0].id} vs ${t0pair[1].id} (identical inputs by the cap observation above)`,
        identical_final_classes: t0pair[0].turns.every((r, i) => r.finalClass === t0pair[1].turns[i].finalClass),
        differing_turns: t0pair[0].turns.map((r, i) => ({ turnId: r.turnId, a: r.finalClass, b: t0pair[1].turns[i].finalClass })).filter((d) => d.a !== d.b),
      }
    : null

  // --- data-driven config suggestion (human judgment recorded in the .md) ---
  const eligible = configs.filter((c) => c.summary.destructive_wrong_outcome_count === 0)
  const ranked = [...(eligible.length ? eligible : configs)].sort((a, b) => {
    if (b.summary.valid_total !== a.summary.valid_total) return b.summary.valid_total - a.summary.valid_total
    if (a.summary.wrong_outcome !== b.summary.wrong_outcome) return a.summary.wrong_outcome - b.summary.wrong_outcome
    return a.latency.all_requests.mean_ms - b.latency.all_requests.mean_ms
  })
  const best = ranked[0]
  const suggestion = {
    config_id: best.id,
    temperature: best.temperature,
    max_tokens: best.max_tokens,
    note_cap: best.noteCap,
    rationale: [
      `valid ${best.summary.valid_total}/20 after ≤1 repair`,
      `destructive wrong-outcomes: ${best.summary.destructive_wrong_outcome_count}`,
      `wrong-outcome total: ${best.summary.wrong_outcome}`,
      `mean latency ${best.latency.all_requests.mean_ms} ms/request`,
      `finish_reason=length occurrences at max_tokens ${best.max_tokens}: ${best.latency.length_truncations}`,
    ],
    caveat: 'data-driven suggestion from this run; the .md records the human read of the verbatim chat replies and the final choice',
  }

  const payload = {
    spike: 'E2 — Omni serving/sampling for a dual-role model',
    generated_at: new Date().toISOString(),
    server: serverInfo,
    e1_winner: winner,
    protocol: 'identical to E1 (same 20 turns verbatim, same scoring, one schema-repair max) — see docs/spikes/E1-omni-directive.json scoring_rules',
    configs,
    note_cap_dimension: capNote,
    determinism_check_temperature_0: determinism,
    reasoning_flag: reasoningFlag,
    suggested_config: suggestion,
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 1) + '\n')
  console.log(`\nwrote ${OUT_PATH}`)
  console.log(`suggested config: ${suggestion.config_id} (${suggestion.rationale.join(' | ')})`)
  console.log(`reasoning flag verdict: ${reasoningFlag.verdict}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => { console.error('E2 spike failed:', error?.stack ?? error); process.exit(2) })
}
