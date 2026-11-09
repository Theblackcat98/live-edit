#!/usr/bin/env node
/**
 * LiquidScribe end-to-end QA battery.
 *
 * Launches a throwaway headless Chrome on port 9226 (its own user-data-dir
 * under /tmp), drives the Vite dev server at http://localhost:5173 over CDP,
 * runs the scenario battery, prints a PASS/FAIL table, exits non-zero if any
 * case failed, and always kills its Chrome.
 *
 * No npm dependencies: Node 22 global fetch/WebSocket only.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const APP_URL = process.env.QA_APP_URL ?? 'http://localhost:5173'
const CDP_PORT = 9226
const STORAGE_KEY = 'liquidscribe.workspace.v1'
const RUN_TIMEOUT_MS = Number(process.env.QA_RUN_TIMEOUT_MS ?? 120_000)

// ---------------------------------------------------------------- chrome ---

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

function findChrome() {
  for (const cand of CHROME_CANDIDATES) {
    if (cand.includes('/')) {
      if (existsSync(cand)) return cand
    } else {
      try {
        return execFileSync('which', [cand], { encoding: 'utf8' }).trim()
      } catch { /* next */ }
    }
  }
  return null
}

const chromeBin = findChrome()
if (!chromeBin) {
  console.error('No Chrome/Chromium binary found (set CHROME_PATH).')
  process.exit(2)
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'liquidscribe-qa-chrome-'))
const chrome = spawn(
  chromeBin,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

let chromeExited = null
chrome.on('exit', (code, signal) => { chromeExited = { code, signal } })

function killChrome() {
  if (chromeExited || chrome.exitCode !== null) return
  try { chrome.kill('SIGKILL') } catch { /* already gone */ }
}

process.on('exit', killChrome)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killChrome(); process.exit(130) })
}

// ------------------------------------------------------------------- cdp ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitDevtools() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (res.ok) return
    } catch { /* not up yet */ }
    if (chromeExited) throw new Error(`Chrome exited early: ${JSON.stringify(chromeExited)}`)
    await sleep(150)
  }
  throw new Error('Chrome DevTools endpoint never came up on port ' + CDP_PORT)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.pageErrors = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
        else resolve(msg.result)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.pageErrors.push(d.exception?.description ?? d.text ?? 'unknown exception')
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        // Network noise like favicon 404s still count; keep them visible.
        this.consoleErrors.push(`[log] ${msg.params.entry.text} (${msg.params.entry.url ?? ''})`)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP ${method} timed out`))
        }
      }, 60_000)
    })
  }
}

async function main() {
  await waitDevtools()

  // One persistent page target for the whole suite.
  const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(APP_URL)}`, {
    method: 'PUT',
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ?? await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(APP_URL)}`).then((r) => r.json())

  const ws = new WebSocket(created.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')))
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')

  // ----------------------------------------------------------- helpers ---

  async function evalJs(expression) {
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error('page eval failed: ' + (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text))
    }
    return res.result.value
  }

  const getWs = () => evalJs(`(() => { const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)}); return raw ? JSON.parse(raw) : null })()`)

  /** Seed a workspace (object) or clear storage (null), reload, wait for app. */
  async function seedWorkspace(state) {
    const payload = state === null ? 'null' : JSON.stringify(JSON.stringify(state))
    await evalJs(
      state === null
        ? `localStorage.removeItem(${JSON.stringify(STORAGE_KEY)})`
        : `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${payload})`,
    )
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(800) // let the navigation actually start before probing DOM
    await waitAppReady()
    await installTtsHook()
  }

  async function waitAppReady(timeout = 30_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evalJs(`!!document.querySelector('.composer-mic') && !!document.querySelector('#command-input')`)) {
        // Confirm twice so we're not reading a dying pre-reload context.
        await sleep(300)
        if (await evalJs(`!!document.querySelector('.composer-mic') && !!document.querySelector('#command-input')`)) return
      }
      await sleep(200)
    }
    throw new Error('app never became ready (no .composer-mic)')
  }

  /** Wait until the app has flushed its first debounced save to localStorage. */
  async function waitStorageFlushed(timeout = 10_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evalJs(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) !== null`)) return
      await sleep(200)
    }
    throw new Error('workspace never persisted to localStorage')
  }

  /** Type into the composer and send. */
  async function submitCommand(text) {
    await evalJs(`(() => {
      const input = document.querySelector('#command-input')
      if (!input) throw new Error('composer input not found')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.composer-send').click()
    })()`)
  }

  /** Last assistant reply currently in the transcript DOM. */
  async function lastReply() {
    return evalJs(`(() => {
      const els = document.querySelectorAll('.session-transcript .message-assistant .message-assistant-text')
      return els.length ? els[els.length - 1].textContent : ''
    })()`)
  }

  /**
   * Case 25 (design.md §13.6): pipeline stage/mechanism vocabulary that must
   * never surface in chat transcript or TTS text. Scoped to the delegation
   * mechanism's own tokens plus the pipeline state machine's stage nouns and
   * provenance nouns. Deliberately absent: the bare role/component names
   * ("worker", "supervisor", "ground …") that the retained legacy canned
   * strings (ackFor/completionFor/buildClarification) still speak through
   * P5 — a hit on harness-authored strings would be a planned-defect false
   * positive (architecture-refactor.md §6.5), not mechanism leakage. The
   * list tightens when P6 deletes those strings.
   */
  const STAGE_VOCABULARY =
    /\b(routing|grounding|critic|critique|directive|pipeline|systemone|noul|stage\s+[abc]|d1)\b/i

  /**
   * Chat hygiene: an assistant reply must never surface raw action markup —
   * no `<tool_call`, no `<function=`, and no fenced block that contains either
   * (models sometimes "show their work" in a code fence). Extended for the
   * Omni-first pipeline (case 25): no delegation tool tokens, no directive
   * delimiters, no call/arguments JSON fragments, no pipeline stage
   * vocabulary.
   */
  function replyHygiene(text) {
    const hits = []
    if (text.includes('<tool_call')) hits.push('<tool_call')
    if (text.includes('<function=')) hits.push('<function=')
    if (/```[\s\S]*?(tool_call|function=)[\s\S]*?```/.test(text)) hits.push('fenced action block')
    if (text.includes('delegate_edit')) hits.push('delegate_edit')
    if (text.includes('<<<DIRECTIVE')) hits.push('<<<DIRECTIVE')
    if (/\btool_call\b/.test(text)) hits.push('tool_call token')
    if (/["']arguments["']\s*:/.test(text)) hits.push('arguments JSON fragment')
    const vocab = text.match(STAGE_VOCABULARY)
    if (vocab) hits.push(`stage vocabulary "${vocab[0]}"`)
    return { ok: hits.length === 0, hits }
  }

  /**
   * Case 25 corpus: every transcript message text and spoken utterance
   * observed across the battery, harvested at each settled run (mutation and
   * conversational cases alike — design.md §13.6 puts the bar on "any
   * case"). A text may be sampled twice if several runs settle in one group;
   * duplicates only make the audit stricter.
   */
  const hygieneCorpus = []

  /**
   * Snapshot transcript + spoken texts into the corpus and reset the TTS
   * log so utterances are recorded exactly once.
   */
  async function harvestHygiene() {
    const sample = await evalJs(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
      const ws = raw ? JSON.parse(raw) : null
      const msgs = (ws && Array.isArray(ws.messages))
        ? ws.messages.map((m) => ({ role: m.role ?? '?', text: typeof m.text === 'string' ? m.text : '' }))
        : []
      const tts = Array.isArray(window.__qaTtsText) ? window.__qaTtsText.slice() : []
      if (Array.isArray(window.__qaTtsText)) window.__qaTtsText.length = 0
      return { msgs, tts }
    })()`)
    for (const m of sample.msgs) {
      if (m.text) hygieneCorpus.push({ kind: `msg/${m.role}`, text: m.text })
    }
    for (const t of sample.tts) {
      if (t) hygieneCorpus.push({ kind: 'tts', text: t })
    }
  }

  /**
   * Record browser TTS utterances so case 25 audits what was actually
   * spoken, not only what was written (the app strips markup before
   * speaking, so spoken text can differ from the transcript). Transparent
   * to the app; re-installed after every seedWorkspace reload because the
   * page reload wipes window globals.
   */
  async function installTtsHook() {
    await evalJs(`(() => {
      if (window.__qaTtsHooked) return
      window.__qaTtsHooked = true
      window.__qaTtsText = []
      const synth = window.speechSynthesis
      if (!synth || typeof synth.speak !== 'function') return
      const original = synth.speak.bind(synth)
      synth.speak = (utterance) => {
        try { window.__qaTtsText.push(String(utterance?.text ?? '')) } catch { /* never break the app */ }
        original(utterance)
      }
    })()`)
  }

  /** Wait until the persisted workspace stops changing (debounced save settled). */
  async function settleState(timeout = 6000) {
    let last = JSON.stringify(await getWs())
    const deadline = Date.now() + timeout
    let since = Date.now()
    while (Date.now() < deadline) {
      await sleep(400)
      const cur = JSON.stringify(await getWs())
      if (cur === last) {
        if (Date.now() - since >= 800) return
      } else {
        last = cur
        since = Date.now()
      }
    }
  }

  // 'pending' is terminal for battery purposes (design.md §9, architecture-
  // refactor.md §9): a run whose edit was routed to user adjudication has
  // released busy and flushed its state — the turn is paused awaiting the
  // user's ✓ / ✗, not hanging. Cases that expect a different terminal still
  // fail on the status comparison; waiting 120s for a settled pending run
  // would only manufacture a timeout where the design says "usable state".
  const TERMINAL = new Set(['verified', 'rejected', 'clarify', 'conversational', 'failed', 'pending'])

  function runsInfo() {
    return evalJs(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
      const ws = raw ? JSON.parse(raw) : null
      const runs = (ws && Array.isArray(ws.runs)) ? ws.runs : []
      const last = runs[0] ?? null // runs are stored newest-first
      return { count: runs.length, status: last ? last.status : null, command: last ? last.command : null,
               critic: last ? last.critic ?? null : null, runtime: last ? last.runtime ?? null : null,
               span: last ? last.span ?? null : null, grounding: last ? last.grounding ?? null : null,
               directive: last ? last.directive ?? null : null, call: last ? last.call ?? null : null,
               d1Check: last ? last.d1Check ?? null : null, route: last ? last.route ?? null : null }
    })()`)
  }

  /** The persisted pending-edit queue (design.md §9 store; arrival order). */
  function pendingInfo() {
    return evalJs(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
      const ws = raw ? JSON.parse(raw) : null
      const edits = (ws && Array.isArray(ws.pendingEdits)) ? ws.pendingEdits : []
      return { count: edits.length, all: edits, last: edits.length ? edits[edits.length - 1] : null }
    })()`)
  }

  /**
   * Drive user adjudication on a pending-edit card (design.md §9 UI contract,
   * architecture-refactor.md §9.3): tap the card's real ✓ Apply / ✗ Discard
   * button, then wait until the entry no longer sits in the persisted queue
   * as 'pending' (lib/pending's toStorable persists only pending entries —
   * an applied/discarded/stale card drops out on the next debounced save).
   */
  async function adjudicatePending(id, decision, { timeout = 20_000 } = {}) {
    const label = decision === 'apply' ? 'Apply proposed edit' : 'Discard proposed edit'
    await evalJs(`(() => {
      const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]')
      if (!b) throw new Error('pending-edit button not found: ' + ${JSON.stringify(label)})
      if (b.disabled) throw new Error('pending-edit button disabled (busy?)')
      b.click()
    })()`)
    const deadline = Date.now() + timeout
    let entry = null
    while (Date.now() < deadline) {
      entry = ((await pendingInfo()).all ?? []).find((e) => e && e.id === id) ?? null
      if (!entry || entry.status !== 'pending') {
        await settleState()
        return { resolved: true, entry }
      }
      await sleep(300)
    }
    return { resolved: false, entry }
  }

  /**
   * Worker-authoring provenance on an Omni-first run trace — the assertion
   * shape architecture-refactor.md §7's gate mandates for the rewritten
   * cases ("traces show directive + worker provenance, no supervisor
   * fields") and design.md §13.8 keeps as the spec. Concretely:
   * - `directive` present: Omni delegated a typed brief (design.md §5);
   * - `call.sampler` present: a live 1.7B decode authored the call — the
   *   deleted template emitter's calls carry no sampler (types.ts WorkerCall);
   * - `call.toolSchemasInjected === 4`: the full tool catalog traveled with
   *   the prompt (design.md §6), not the supervisor's single-schema handoff;
   * - `route`/`grounding` absent: no supervisor-era RouteDecision and no
   *   d1-span/fallback-keyword grounding record — grounding is the worker's
   *   job now (plan §7.3 deletes findSpanForMutation & friends).
   */
  function workerAuthored(run) {
    return Boolean(
      run?.directive &&
      run?.call?.sampler &&
      run?.call?.toolSchemasInjected === 4 &&
      run?.route == null &&
      run?.grounding == null,
    )
  }

  /**
   * Wait for a new terminal run. Returns {status, critic, runtime}.
   * Also samples the streaming transcript so callers can inspect growth.
   */
  async function waitForRun({ timeout = RUN_TIMEOUT_MS, sample = false } = {}) {
    const before = await runsInfo()
    const samples = []
    const deadline = Date.now() + timeout
    let lastText = ''
    let stableSince = null
    while (Date.now() < deadline) {
      if (sample) {
        const text = await evalJs(`(() => {
          const els = document.querySelectorAll('.session-transcript .message-assistant .message-assistant-text')
          return els.length ? els[els.length - 1].textContent : ''
        })()`)
        samples.push({ at: Date.now(), length: text.length })
      }
      const info = await runsInfo()
      if (info.count > before.count && TERMINAL.has(info.status)) {
        await settleState()
        await harvestHygiene()
        return { ...info, samples }
      }
      await sleep(300)
    }
    const final = await runsInfo()
    return { ...final, timedOut: true, samples }
  }

  /**
   * Wait until the last assistant transcript bubble stops growing (streaming
   * replies arrive token by token). Returns {text, samples}.
   */
  async function waitForReplySettled({ timeout = RUN_TIMEOUT_MS, minSamples = 0 } = {}) {
    const samples = []
    const deadline = Date.now() + timeout
    let lastLen = -1
    let stableCount = 0
    while (Date.now() < deadline) {
      const el = await evalJs(`(() => {
        const els = document.querySelectorAll('.session-transcript .message-assistant .message-assistant-text')
        return els.length ? els[els.length - 1].textContent : ''
      })()`)
      samples.push(el.length)
      if (el.length === lastLen) {
        stableCount += 1
        if (stableCount >= 3 && samples.length >= minSamples) return { text: el, samples }
      } else {
        stableCount = 0
      }
      lastLen = el.length
      await sleep(300)
    }
    return { text: '', samples, timedOut: true }
  }

  async function note() {
    const ws = await getWs()
    return ws?.note ?? null
  }

  // ------------------------------------------------------------ battery ---

  /** @type {{id:string,title:string,status:'PASS'|'FAIL'|'KNOWN-BUG',evidence:string}[]} */
  const results = []
  function record(id, title, ok, evidence, knownBug = false) {
    results.push({
      id, title,
      status: knownBug ? 'KNOWN-BUG' : ok ? 'PASS' : 'FAIL',
      evidence: evidence.slice(0, 220),
    })
    console.log(`  [${results.at(-1).status}] ${id} — ${title}`)
    if (!ok && !knownBug) console.log(`         ${evidence.slice(0, 300)}`)
  }

  const t0 = Date.now()
  let group = ''
  const say = (s) => { group = s; console.log(`\n== ${s}`) }

  // --- Group A: fresh seed + conversational battery ----------------------
  say('Group A: fresh seed, greeting, memory, vision')
  await seedWorkspace(null)
  await waitStorageFlushed()

  {
    const ws = await getWs()
    const noteText = ws?.note ?? ''
    const lines = noteText.split('\n').length
    const msgCount = ws?.messages?.length ?? 0
    const ok = lines === 43 && /Q3 Business Review/.test(noteText) && /Redis/.test(noteText) && /Security/.test(noteText) && msgCount >= 1
    record('1', 'fresh seed: demo note + greeting', ok,
      `note lines=${lines} (want 43), messages=${msgCount}, hasQ3=${/Q3 Business Review/.test(noteText)}, consoleErrors=${cdp.consoleErrors.length + cdp.pageErrors.length}`)
    const noErrors = cdp.consoleErrors.length === 0 && cdp.pageErrors.length === 0
    record('1b', 'fresh seed: zero console errors', noErrors,
      noErrors ? 'no console/exception entries' : cdp.consoleErrors.concat(cdp.pageErrors).slice(0, 3).join(' | '))
  }

  await submitCommand('hey')
  {
    const run = await waitForRun()
    const reply = await waitForReplySettled()
    const ws = await getWs()
    const status = ws?.runs?.at(-1)?.status
    const noClarify = status !== 'clarify' && !ws?.messages?.some((m) => m.kind === 'clarify')
    const clean = !/revenue|pending|slide/i.test(reply.text)
    const hygiene = replyHygiene(reply.text)
    record('2', `greeting "hey" → conversational, no clarify, clean reply, no action markup`,
      status === 'conversational' && noClarify && clean && hygiene.ok,
      `status=${status}, reply="${reply.text.slice(0, 80)}", runtime.chat=${ws?.runs?.at(-1)?.runtime?.chat}, hygiene=${hygiene.ok ? 'clean' : hygiene.hits.join('+')}`)
  }

  await submitCommand('remember that my favorite color is teal')
  {
    const run = await waitForRun()
    const reply = await waitForReplySettled()
    const ws = await getWs()
    const status = ws?.runs?.at(-1)?.status
    record('3', 'personal statement → conversational (not mutation/clarify)',
      status === 'conversational',
      `status=${status}, reply="${reply.text.slice(0, 80)}"`)
  }

  await submitCommand('what is my favorite color?')
  {
    const run = await waitForRun()
    const reply = await waitForReplySettled()
    record('4', 'memory recall: reply mentions teal', /teal/i.test(reply.text),
      `reply="${reply.text.slice(0, 100)}"`)
  }

  {
    const wsBefore = await getWs()
    await submitCommand('what can you see?')
    const run = await waitForRun()
    const reply = await waitForReplySettled()
    const ws = await getWs()
    const status = ws?.runs?.at(-1)?.status
    const mentionsScene = /bar chart|table|LTV|slide|scene|camera/i.test(reply.text)
    const chatLive = ws?.runs?.at(-1)?.runtime?.chat === 'live'
    record('5', `visual question: conversational + scene content + omni chat live`,
      status === 'conversational' && mentionsScene && chatLive,
      `status=${status}, sceneHit=${mentionsScene}, runtime.chat=${ws?.runs?.at(-1)?.runtime?.chat}, reply="${reply.text.slice(0, 90)}"`)
  }

  // --- Group B: mutations, undo/redo, clarify ----------------------------
  say('Group B: typed edits, undo/redo, ambiguity')
  await seedWorkspace(null)
  await waitStorageFlushed()

  const freshSnapshots = (await getWs())?.snapshots?.length ?? 0
  await submitCommand('update the Q3 revenue row to $1.45M Final')
  {
    const run = await waitForRun()
    const ws = await getWs()
    const status = ws?.runs?.at(-1)?.status
    const hasVal = (ws?.note ?? '').includes('$1.45M')
    const grew = (ws?.snapshots?.length ?? 0) > freshSnapshots
    record('6', 'typed edit Q3 revenue row → verified + diff + snapshot',
      status === 'verified' && hasVal && grew,
      `status=${status}, noteHas$1.45M=${hasVal}, snapshots ${freshSnapshots}→${ws?.snapshots?.length}`)
  }

  await submitCommand('undo that')
  {
    const run = await waitForRun()
    const n = await note()
    record('10a', 'undo that → $1.45M gone', !n.includes('$1.45M'),
      `status=${(await runsInfo()).status}, containsValue=${n.includes('$1.45M')}, reply="${(await lastReply()).slice(0, 90)}"`)
  }
  await submitCommand('redo it')
  {
    const run = await waitForRun()
    const n = await note()
    record('10b', 'redo it → $1.45M back', n.includes('$1.45M'),
      `status=${(await runsInfo()).status}, containsValue=${n.includes('$1.45M')}`)
  }

  await submitCommand('remove the bullet about Redis')
  {
    const run = await waitForRun()
    const n = await note()
    const info = await runsInfo()
    record('7', 'remove Redis bullet → verified, Redis gone',
      info.status === 'verified' && !n.includes('Redis'),
      `status=${info.status}, stillHasRedis=${n.includes('Redis')}`)
  }

  await submitCommand('add a line under Security: rotate keys monthly')
  {
    const run = await waitForRun()
    const n = await note()
    const info = await runsInfo()
    record('8', 'add line under Security → verified, present',
      info.status === 'verified' && /rotate keys monthly/i.test(n) && !/under Security:/i.test(n),
      `status=${info.status}, hasLine=${/rotate keys monthly/i.test(n)}, junkPrefix=${/under Security:/i.test(n)}`)
  }

  await submitCommand('pull the LTV/CAC formula from the slide into Revenue')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = await note()
    if (info.status === 'verified') {
      record('9', 'extract LTV/CAC formula → verified', true,
        `status=verified, noteHasLTV=${n.includes('LTV')}`)
    } else if (info.status === 'clarify') {
      const clarifyMsg = (await getWs())?.messages?.filter((m) => m.kind === 'clarify').at(-1)?.text ?? '(no clarify text)'
      const sensible = clarifyMsg.length > 10 && /\?/.test(clarifyMsg)
      record('9', 'extract LTV/CAC formula → clarify (needs review)', sensible,
        `status=clarify, clarify="${clarifyMsg.slice(0, 120)}" — FLAG FOR REVIEW`)
    } else {
      record('9', 'extract LTV/CAC formula → run completed', false,
        `status=${info.status}`)
    }
  }

  const noteBeforeAmbiguous = await note()
  await submitCommand('change the number')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = await note()
    record('11', 'ambiguous "change the number" → clarify, note unchanged',
      info.status === 'clarify' && n === noteBeforeAmbiguous,
      `status=${info.status}, noteUnchanged=${n === noteBeforeAmbiguous}, reply="${(await lastReply()).slice(0, 90)}"`)
  }

  // --- Group C: empty-document templates + deterministic rejection ------
  say('Group C: empty-document templates, deterministic rejection, trace export')

  // Same command as the supervisor-era case, rewritten per plan §7's gate:
  // "Cases 12/12b/12d/12e (empty-doc templates) are rewritten as
  // worker-authored template cases — same commands, new provenance
  // assertions." The content bar stays (a real multi-section README, no
  // spoken-command leak — design.md §13.1's shape); the deterministic
  // template synthesizer is deleted (plan §7.3), so the provenance bar moves
  // to workerAuthored(): Omni directive + live worker call + no supervisor
  // fields (route/grounding), with d1's §7 check approving the four-stage
  // chain (plan §15's trace contract).
  await seedWorkspace({ version: 1, note: '', snapshots: [], messages: [], runs: [], rejectedTraces: [] })
  await submitCommand('Create a readme template in this document, rename the title appropriately')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const ws = await getWs()
    const n = ws?.note ?? ''
    const junkLeak = /rename the title/i.test(n)
    const authored = workerAuthored(info) && info.directive?.task === 'create'
    record('12', 'EMPTY DOC + readme template → verified, worker-authored README (Omni directive + live worker call, no supervisor fields)',
      info.status === 'verified' && authored && n.startsWith('# README') && n.split('\n').length >= 20 && !junkLeak,
      `status=${info.status}, workerAuthored=${authored}, task=${info.directive?.task ?? '-'}, sampler=${info.call?.sampler ? 'live' : '-'}, schemas=${info.call?.toolSchemasInjected ?? '-'}, d1=${info.d1Check?.verdict ?? '-'}, lines=${n.split('\n').length}, startsREADME=${n.startsWith('# README')}, junkLeak=${junkLeak}${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  // Second template kind on a fresh empty document — same command, rewritten
  // per plan §7's gate (worker-authored template case, new provenance
  // assertions). The failed gate run showed this command legitimately
  // settling as d1-disapproved → pending (design.md §9: a disapproval is a
  // decision for the user, not a dead end — plan §8/§9), so the case
  // adjudicates honestly instead of timing out: on 'pending' it asserts the
  // pending card (d1 verdict, worker proposal, note untouched), taps the
  // card's ✓ (hard gates re-run on approval — design.md §8), and requires
  // the worker-authored changelog to land with a snapshot. On 'verified' it
  // asserts the same worker-authored bar directly. Both branches keep the
  // workerAuthored() provenance contract (plan §7) — a template emitter
  // styled call passes neither.
  await seedWorkspace({ version: 1, note: '', snapshots: [], messages: [], runs: [], rejectedTraces: [] })
  const snapsBefore12b = (await getWs())?.snapshots?.length ?? 0
  await submitCommand('create a changelog template in this document')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    let ok = false
    let evidence = ''
    const n12b = (await getWs())?.note ?? ''
    const junkLeak = /in this document/i.test(n12b)
    if (info.status === 'pending') {
      const pending = await pendingInfo()
      const card = pending.last
      const cardOk = Boolean(
        card && card.status === 'pending' &&
        card.d1 && (card.d1.verdict === 'disapproved' || card.d1.verdict === 'unavailable') &&
        card.directive?.task === 'create' && card.call?.name,
      )
      // design.md §9: until ✓, the pending edit modifies nothing.
      const untouched = n12b === ''
      const authored = workerAuthored(info) && info.directive?.task === 'create'
      const proposalOk = cardOk && untouched && authored
      const adjudication = proposalOk && card ? await adjudicatePending(card.id, 'apply') : { resolved: false, entry: null }
      const nAfter = (await getWs())?.note ?? ''
      const snapsAfter = (await getWs())?.snapshots?.length ?? 0
      const appliedOk = adjudication.resolved && adjudication.entry?.status === 'applied' &&
        nAfter.startsWith('# Changelog') && !junkLeak && snapsAfter > snapsBefore12b
      ok = proposalOk && appliedOk
      evidence = `status=pending, d1=${card?.d1?.verdict ?? '-'}, task=${card?.directive?.task ?? '-'}, workerAuthored=${authored}, noteUntouchedWhilePending=${untouched}, applied=${adjudication.resolved ? adjudication.entry?.status ?? '?' : 'unresolved'}, head=${JSON.stringify(nAfter.slice(0, 40))}, junkLeak=${junkLeak}, snaps ${snapsBefore12b}→${snapsAfter}`
    } else {
      const authored = workerAuthored(info) && info.directive?.task === 'create'
      ok = info.status === 'verified' && authored && n12b.startsWith('# Changelog') && !junkLeak
      evidence = `status=${info.status}, workerAuthored=${authored}, task=${info.directive?.task ?? '-'}, sampler=${info.call?.sampler ? 'live' : '-'}, d1=${info.d1Check?.verdict ?? '-'}, head=${JSON.stringify(n12b.slice(0, 40))}, junkLeak=${junkLeak}`
    }
    record('12b', 'EMPTY DOC + changelog template → worker-authored changelog via d1 adjudication (✓ applies) or direct approval',
      ok, `${evidence}${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  // Natural phrasing: the verb is no longer first ("The document is empty
  // now, begin by writing …"). Plan §7's gate rewrites this as a
  // worker-authored template case — same command; the sentence-style phrasing
  // must still resolve into Omni's create brief and the worker must author
  // the README (the template synthesizer this case used to exercise is
  // deleted, plan §7.3). Content bar and junk-leak check stay.
  await seedWorkspace({ version: 1, note: '', snapshots: [], messages: [], runs: [], rejectedTraces: [] })
  await submitCommand('The document is empty now, begin by writing a readme template .md doc')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = (await getWs())?.note ?? ''
    const junkLeak = /document is empty now/i.test(n)
    const authored = workerAuthored(info) && info.directive?.task === 'create'
    record('12d', 'EMPTY DOC + sentence-style readme → verified, worker-authored README (Omni directive + live worker call)',
      info.status === 'verified' && authored && n.startsWith('# README') && n.split('\n').length >= 20 && !junkLeak,
      `status=${info.status}, workerAuthored=${authored}, task=${info.directive?.task ?? '-'}, sampler=${info.call?.sampler ? 'live' : '-'}, schemas=${info.call?.toolSchemasInjected ?? '-'}, d1=${info.d1Check?.verdict ?? '-'}, lines=${n.split('\n').length}, startsREADME=${n.startsWith('# README')}, junkLeak=${junkLeak}${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  // Filler-prefixed phrasing ("hey, go ahead and …") on a fresh empty doc —
  // rewritten per plan §7's gate: same command, worker-authored provenance
  // assertions. The content bar (# Changelog authored, filler text never
  // leaks into the note — design.md §13.1's "no literal command phrase as
  // inserted content" shape) stays hard; the failed gate run's wrong content
  // here is worker quality and stays failing until that parallel fix lands.
  await seedWorkspace({ version: 1, note: '', snapshots: [], messages: [], runs: [], rejectedTraces: [] })
  await submitCommand('hey, go ahead and create a changelog template')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = (await getWs())?.note ?? ''
    const junkLeak = /hey, go ahead/i.test(n)
    const authored = workerAuthored(info) && info.directive?.task === 'create'
    record('12e', 'EMPTY DOC + filler-prefixed changelog → verified, worker-authored # Changelog',
      info.status === 'verified' && authored && /^# Changelog/m.test(n) && !junkLeak,
      `status=${info.status}, workerAuthored=${authored}, task=${info.directive?.task ?? '-'}, sampler=${info.call?.sampler ? 'live' : '-'}, schemas=${info.call?.toolSchemasInjected ?? '-'}, d1=${info.d1Check?.verdict ?? '-'}, head=${JSON.stringify(n.slice(0, 40))}, junkLeak=${junkLeak}${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  // Deterministic floor on the demo note: replacing the long Risks section
  // with a two-word payload is the audit's blast-radius case. Plan §8's gate
  // rewrites its terminal expectation: "case 12c (blast radius) can now end
  // only as hard-gate refusal or pending — never auto-verified." If the
  // worker authors the over-broad call, runHardGates refuses it (design.md
  // §8: a hard-gate failure is never adjudicable) → 'rejected' with a
  // rejected-traces record; if the worker authors a narrower call that
  // passes the gates, d1's §7 check may disapprove → 'pending' for the user.
  // Either way the note must be byte-unchanged — no destructive call ever
  // executes — and a refusal must record the Omni-first provenance
  // (worker-self grounding + directive) in the rejected-traces log.
  await seedWorkspace(null)
  await waitStorageFlushed()
  const rejectsBefore = (await getWs())?.rejectedTraces?.length ?? 0
  const noteBeforeBlast = await note()
  let blast12c = { status: null, rejectedGrew: false, pendingId: null }
  await submitCommand('Replace the Risks section with tiny')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const ws = await getWs()
    const n = ws?.note ?? ''
    const noteUnchanged = n === noteBeforeBlast && /## 4\./.test(n) && /Risks/.test(n)
    const grew = (ws?.rejectedTraces?.length ?? 0) > rejectsBefore
    const terminalIsRefusalOrPending = info.status === 'rejected' || info.status === 'pending'
    let terminalEvidenceOk = false
    let terminalDetail = ''
    if (info.status === 'rejected') {
      // recordOmniRejection shape (plan §7/§8): worker-self grounding, the
      // Omni directive, no supervisor critic verdict.
      const rec = ws?.rejectedTraces?.at(-1)
      const provenanceOk = Boolean(
        rec &&
        rec.route?.provenance === 'omni-first pipeline' &&
        rec.grounding?.source === 'worker-self' &&
        rec.directive?.instruction,
      )
      terminalEvidenceOk = grew && provenanceOk
      terminalDetail = `rejectedRecord.provenance=${rec?.route?.provenance ?? '-'}, rejectedRecord.grounding=${rec?.grounding?.source ?? '-'}, rejectedRecord.hasDirective=${Boolean(rec?.directive)}`
      blast12c = { status: 'rejected', rejectedGrew: grew, pendingId: null }
    } else if (info.status === 'pending') {
      const card = (await pendingInfo()).last
      terminalEvidenceOk = Boolean(
        card && card.status === 'pending' && card.call?.name &&
        card.d1 && (card.d1.verdict === 'disapproved' || card.d1.verdict === 'unavailable'),
      )
      terminalDetail = `pendingCard.d1=${card?.d1?.verdict ?? '-'}, pendingCard.call=${card?.call?.name ?? '-'}`
      blast12c = { status: 'pending', rejectedGrew: false, pendingId: card?.id ?? null }
    } else {
      terminalDetail = `terminal ${info.status} is neither hard-gate refusal nor pending`
      blast12c = { status: info.status, rejectedGrew: false, pendingId: null }
    }
    record('12c', 'blast-radius replace → hard-gate refusal (rejected) or pending, never auto-verified; note unchanged',
      terminalIsRefusalOrPending && terminalEvidenceOk && noteUnchanged,
      `status=${info.status}, noteUnchanged=${noteUnchanged}, rejectedTraces ${rejectsBefore}→${ws?.rejectedTraces?.length ?? 0}, d1=${info.d1Check?.verdict ?? '-'}, ${terminalDetail}${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  {
    // Rejection-path export: drawer reachable via header 'Open decision
    // trace'. Robust to either 12c terminal (plan §8's gate allows refusal
    // or pending): a hard-gate refusal already fed the log; if 12c landed
    // pending instead, the user's ✗ feeds it here (design.md §9.5 /
    // architecture-refactor.md §9.5: discarding a pending edit appends the
    // proposal — directive, call, d1 verdict — to the rejected-traces log
    // and writes nothing). If 12c produced neither, the precondition is
    // honestly absent and the case fails.
    let discardOutcome = null
    if (!((await getWs())?.rejectedTraces?.length ?? 0) && blast12c.pendingId) {
      discardOutcome = await adjudicatePending(blast12c.pendingId, 'discard')
      const nAfterDiscard = await note()
      if (nAfterDiscard !== noteBeforeBlast) {
        discardOutcome = { resolved: false, entry: null, noteMoved: true }
      }
    }
    const hasRejections = ((await getWs())?.rejectedTraces?.length ?? 0) > 0
    await evalJs(`document.querySelector('[aria-label="Open decision trace"]')?.click()`)
    await sleep(400)
    const exportBtn = await evalJs(`(() => {
      const b = document.querySelector('.trace-export-button')
      return b ? { disabled: b.disabled, title: b.title, text: b.textContent.trim() } : null
    })()`)
    record('16a', 'rejected-traces export enabled after rejection',
      hasRejections && Boolean(exportBtn) && !exportBtn.disabled && /rejected trace/i.test(exportBtn.title),
      `blast12c=${blast12c.status ?? '-'}, discard=${discardOutcome ? `${discardOutcome.resolved ? discardOutcome.entry?.status ?? 'resolved' : 'unresolved'}` : 'not-needed'}, button=${JSON.stringify(exportBtn)}`)
    await evalJs(`document.querySelector('[aria-label="Close decision trace"]')?.click()`)
  }

  // --- Group D: fresh session export disabled, speaker, new note/chat ----
  say('Group D: export disabled state, stop-audio barge-in, note/chat reset, persistence')
  await seedWorkspace(null)
  await waitStorageFlushed()
  const greetingCountBaseline = (await getWs())?.messages?.length ?? 2

  // Create a non-rejected trace so the drawer can open on a clean session.
  await submitCommand('hey')
  await waitForRun()
  await evalJs(`document.querySelector('[aria-label="Open decision trace"]')?.click()`)
  await sleep(400)
  {
    const exportBtn = await evalJs(`(() => {
      const b = document.querySelector('.trace-export-button')
      return b ? { disabled: b.disabled, title: b.title } : null
    })()`)
    record('16b', 'export disabled + explanatory title with no rejections',
      Boolean(exportBtn) && exportBtn.disabled && /no rejected traces/i.test(exportBtn.title),
      `button=${JSON.stringify(exportBtn)}`)
    await evalJs(`document.querySelector('[aria-label="Close decision trace"]')?.click()`)
  }

  {
    // Speaker on (top bar toggle), long reply, barge-in.
    await evalJs(`document.querySelector('[aria-label="Enable spoken replies"]')?.click()`)
    await sleep(200)
    const speakerNow = await evalJs(`!!document.querySelector('[aria-label="Mute spoken replies"]')`)
    await submitCommand('tell me a story about a lighthouse, three paragraphs')
    const settled = await waitForReplySettled({ minSamples: 4 })
    const stopBtn = () => evalJs(`(() => {
      const b = [...document.querySelectorAll('.session-header button')].find((x) => x.textContent.includes('Stop audio'))
      return b ? { disabled: b.disabled } : null
    })()`)
    const stopDuring = await stopBtn()
    record('17a', 'Stop audio enabled while speaking long reply',
      Boolean(stopDuring) && !stopDuring.disabled,
      `stopButton=${JSON.stringify(stopDuring)} (speakerOn=${speakerNow}, replyLen=${settled.text.length})`)

    record('18', 'streaming sanity: bubble grows in ≥2 distinct sampled lengths', (() => {
      const lens = settled.samples
      return new Set(lens).size >= 2 && lens.length >= 3
    })(), `samples=${JSON.stringify(settled.samples.slice(0, 12))}`)

    const tSend = Date.now()
    await submitCommand('thanks')
    let disabledAt = null
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const b = await stopBtn()
      if (b?.disabled) { disabledAt = Date.now() - tSend; break }
      await sleep(150)
    }
    record('17b', 'barge-in: Stop audio disabled again within 2s of next command',
      disabledAt !== null && disabledAt <= 2000,
      disabledAt === null ? `never disabled within window; stopButton=${JSON.stringify(await stopBtn())}` : `disabled after ${disabledAt}ms`)
    // The 'thanks' run must fully finish: New note / New chat no-op while busy.
    await waitForRun()
    // mute again so later audio isn't spawned
    await evalJs(`document.querySelector('[aria-label="Mute spoken replies"]')?.click()`)
  }

  {
    const noteBefore = await note()
    const snapsBefore = (await getWs())?.snapshots?.length ?? 0
    const btnState = await evalJs(`(() => {
      const b = document.querySelector('[aria-label="New note"]')
      return b ? { disabled: b.disabled } : null
    })()`)
    await evalJs(`document.querySelector('[aria-label="New note"]')?.click()`)
    let n = await note()
    const deadline = Date.now() + 5000
    while (n !== '# Untitled' && Date.now() < deadline) {
      await sleep(300)
      n = await note()
    }
    const snapsAfter = (await getWs())?.snapshots?.length ?? 0
    const becameUntitled = String(n).trim() === '# Untitled'
    record('13a', 'New note → # Untitled + snapshot grows',
      becameUntitled && snapsAfter > snapsBefore,
      `note="${String(n).slice(0, 40)}", snapshots ${snapsBefore}→${snapsAfter}, button=${JSON.stringify(btnState)}`)
    await evalJs(`document.querySelector('[aria-label="Undo last change"]')?.click()`)
    await settleState()
    const n2 = await note()
    record('13b', 'Undo restores previous note', n2 === noteBefore,
      `restored=${n2 === noteBefore}, len=${n2?.length}`)
  }

  {
    const noteBefore = await note()
    const msgsBefore = (await getWs())?.messages?.length ?? 0
    const btnState = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.session-header button')].find((x) => x.textContent.includes('New chat'))
      return b ? { disabled: b.disabled } : null
    })()`)
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.session-header button')].find((x) => x.textContent.includes('New chat'))
      b?.click()
    })()`)
    let msgsAfter = -1
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      msgsAfter = (await getWs())?.messages?.length ?? -1
      if (msgsAfter === greetingCountBaseline) break
      await sleep(300)
    }
    record('14', 'New chat → messages reset to greeting, note unchanged',
      msgsAfter === greetingCountBaseline && (await note()) === noteBefore,
      `messages ${msgsBefore}→${msgsAfter} (greeting baseline ${greetingCountBaseline}), noteUnchanged=${(await note()) === noteBefore}, button=${JSON.stringify(btnState)}`)
  }

  {
    // Persistence: reload, compare note + counts byte-identically.
    const before = await evalJs(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
      const ws = raw ? JSON.parse(raw) : {}
      return { note: ws.note, messages: (ws.messages ?? []).length, runs: (ws.runs ?? []).length, snapshots: (ws.snapshots ?? []).length, rawNote: ws.note }
    })()`)
    const domNoteBefore = await evalJs(`document.body.innerHTML.length`) // crude DOM fingerprint too
    await cdp.send('Page.reload', { ignoreCache: false })
    await waitAppReady()
    const after = await evalJs(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
      const ws = raw ? JSON.parse(raw) : {}
      return { note: ws.note, messages: (ws.messages ?? []).length, runs: (ws.runs ?? []).length, snapshots: (ws.snapshots ?? []).length }
    })()`)
    const same = before.note === after.note && before.messages === after.messages &&
      before.runs === after.runs && before.snapshots === after.snapshots
    record('15', 'persistence: reload keeps note byte-identical + counts',
      same,
      `noteSame=${before.note === after.note} (len ${before.note?.length} vs ${after.note?.length}), msgs ${before.messages}→${after.messages}, runs ${before.runs}→${after.runs}, snaps ${before.snapshots}→${after.snapshots}, domLen ${domNoteBefore}`)
  }

  // --- Group E: spoken-style phrasing, title rename, hypothetical --------
  say('Group E: spoken-style phrasing, title rename, hypothetical question')
  await seedWorkspace(null)
  await waitStorageFlushed()

  await submitCommand('hey, could you add a bullet under Follow-ups saying send the deck to finance')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = await note()
    record('19', 'spoken-style "add a bullet under Follow-ups saying …" → verified',
      info.status === 'verified' && /send the deck to finance/i.test(n),
      `status=${info.status}, hasLine=${/send the deck to finance/i.test(n)}${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  await submitCommand('Rename the title to Q3 Review Final')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const first = (await note()).split('\n')[0]
    record('20', 'rename the title → verified, H1 replaced exactly',
      info.status === 'verified' && first === '# Q3 Review Final',
      `status=${info.status}, firstLine=${JSON.stringify(first)}`)
  }

  await submitCommand('um, please delete the bullet about API keys')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = await note()
    record('21', 'filler-prefixed delete → verified, API keys gone',
      info.status === 'verified' && !n.includes('API keys'),
      `status=${info.status}, stillHas=${n.includes('API keys')}`)
  }

  const noteBeforeHypo = await note()
  await submitCommand('what happens if I remove the Q3 row?')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const unchanged = (await note()) === noteBeforeHypo
    record('22', 'hypothetical "what happens if I remove…" → conversational, note unchanged',
      info.status === 'conversational' && unchanged,
      `status=${info.status}, noteUnchanged=${unchanged}, reply="${(await lastReply()).slice(0, 80)}"`)
  }

  // Vague-reference grounding, rewritten per plan §7's gate: "cases 23/24
  // rewritten — they asserted d1 grounding; they now assert worker grounding
  // on the same vague commands" (design.md §13.8: rewritten to spec, not
  // deleted). The supervisor-era d1 typed span question is deleted (plan
  // §8.2), so grounding provenance moves to the worker (design.md §3: the
  // worker "grounds its own target span (line numbers + exact anchor)") and
  // the trace must show the four-stage chain — Omni directive → worker call
  // → hard gates → d1 check approved (plan §15). Both cases start from the
  // pristine demo note.
  await seedWorkspace(null)
  await waitStorageFlushed()

  await submitCommand('remove that section about API keys')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = await note()
    const sectionGone = !/API keys/.test(n) && !/SSO audit/.test(n)
    const neighboursKept = /## 3\. Product notes/.test(n) && /Redis cache migration/.test(n)
    const workerGrounded = workerAuthored(info) &&
      /^\d+$/.test(String(info.call?.params?.start_line ?? '')) &&
      /^\d+$/.test(String(info.call?.params?.end_line ?? ''))
    record('23', 'vague "remove that section about API keys" → worker grounds the Security section (directive + live call, no supervisor fields)',
      info.status === 'verified' && sectionGone && neighboursKept && workerGrounded && info.d1Check?.verdict === 'approved',
      `status=${info.status}, sectionGone=${sectionGone}, neighboursKept=${neighboursKept}, workerGrounded=${workerGrounded}, task=${info.directive?.task ?? '-'}, span=${info.call?.params?.start_line ?? '-'}-${info.call?.params?.end_line ?? '-'}, tool=${info.call?.name ?? '-'}, sampler=${info.call?.sampler ? 'live' : '-'}, grounding=${JSON.stringify(info.grounding)}, d1=${info.d1Check?.verdict ?? '-'}${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  await seedWorkspace(null)
  await waitStorageFlushed()

  await submitCommand('delete the bullet about the audit')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = await note()
    const bulletGone = !/SSO audit/.test(n)
    const neighboursKept =
      /Rotate production API keys/.test(n) && /Mobile capture beta reached/.test(n)
    // Same worker-grounding contract as case 23 (plan §7's gate rewrites
    // both); the vague-command shape is kept verbatim.
    const workerGrounded = workerAuthored(info) &&
      /^\d+$/.test(String(info.call?.params?.start_line ?? '')) &&
      /^\d+$/.test(String(info.call?.params?.end_line ?? ''))
    record('24', 'vague "delete the bullet about the audit" → worker grounds the SSO list item (directive + live call, no supervisor fields)',
      info.status === 'verified' && bulletGone && neighboursKept && workerGrounded && info.d1Check?.verdict === 'approved',
      `status=${info.status}, bulletGone=${bulletGone}, neighboursKept=${neighboursKept}, workerGrounded=${workerGrounded}, task=${info.directive?.task ?? '-'}, span=${info.call?.params?.start_line ?? '-'}-${info.call?.params?.end_line ?? '-'}, tool=${info.call?.name ?? '-'}, sampler=${info.call?.sampler ? 'live' : '-'}, grounding=${JSON.stringify(info.grounding)}, d1=${info.d1Check?.verdict ?? '-'}${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  // --- Group F: P2 gates — delegation hygiene + ambiguous → Omni clarify -
  // The two architecture-refactor.md §6 P2 gate cases. Case 25 audits the
  // corpus harvested across every group above (it needs no new turns); case
  // 26 sends the design's ambiguous command and binds the Omni clarify
  // outcome (plan §6.2 — clarify is Omni's move, made before delegating).
  // Both are authored to the P2 spec; they only bind as model-behaviour
  // gates once the orchestrator wires runOmniTurn in front of the pipeline.
  say('Group F: delegation hygiene (design.md §13.6), ambiguous → Omni clarify')

  {
    const violations = []
    for (const sample of hygieneCorpus) {
      const hygiene = replyHygiene(sample.text)
      if (!hygiene.ok) {
        violations.push(`${sample.kind} → ${hygiene.hits.join('+')} in ${JSON.stringify(sample.text.slice(0, 70))}`)
      }
    }
    record('25', 'delegation hygiene: no mechanism markup in transcript/TTS across all cases',
      hygieneCorpus.length > 0 && violations.length === 0,
      violations.length
        ? violations.slice(0, 3).join(' | ')
        : `${hygieneCorpus.length} transcript + TTS texts checked, all clean`)
  }

  await seedWorkspace(null)
  await waitStorageFlushed()
  const noteBeforeClarify = await note()
  await submitCommand('change the number')
  {
    const run = await waitForRun()
    const info = await runsInfo()
    const n = await note()
    const settled = await waitForReplySettled()
    const clarifyMsg =
      (await getWs())?.messages?.filter((m) => m.kind === 'clarify').at(-1)?.text ?? ''
    // The exact wording is model-generated; bind to the shape of a
    // clarifying question about the ambiguous target, not its phrasing.
    // Design.md §10: clarification is Omni's move, made before delegating —
    // Omni legitimately asks confirm-style questions ("Could you confirm the
    // exact value …?"), which the old which/what/where regex read as no
    // question at all (plan §6.2 gate: the case binds the clarify *outcome*,
    // and the reply must still be a question — the ? requirement below keeps
    // that honest: prose without an interrogative is not a clarification).
    const reply = settled.text || clarifyMsg
    const asksWhichTarget = /\?/.test(reply) && /which|what|where|confirm|specify|clarif/i.test(reply)
    record('26', 'ambiguous "change the number" → clarify, note byte-unchanged, reply asks which number/target',
      info.status === 'clarify' && n === noteBeforeClarify && asksWhichTarget,
      `status=${info.status}, noteUnchanged=${n === noteBeforeClarify}, asksWhichTarget=${asksWhichTarget}, reply="${reply.slice(0, 90)}"${run.timedOut ? ', TIMEOUT' : ''}`)
  }

  // ------------------------------------------------------------- report ---
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const consoleClean = cdp.consoleErrors.length === 0 && cdp.pageErrors.length === 0

  console.log('\n================ QA BATTERY RESULT ================')
  const idWidth = 4
  for (const r of results) {
    const pad = r.status === 'PASS' ? 'PASS      ' : r.status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m      ' : '\x1b[33mKNOWN-BUG\x1b[0m'
    console.log(`${r.id.padEnd(idWidth)} ${pad} ${r.title}`)
    console.log(`${' '.repeat(idWidth)}           ${r.evidence}`)
  }
  const fails = results.filter((r) => r.status === 'FAIL')
  const knownBugs = results.filter((r) => r.status === 'KNOWN-BUG')
  console.log('---------------------------------------------------')
  console.log(`Total ${results.length} | PASS ${results.length - fails.length - knownBugs.length} | FAIL ${fails.length} | KNOWN-BUG ${knownBugs.length}`)
  console.log(`Suite runtime: ${elapsed}s | console errors: ${cdp.consoleErrors.length} | page exceptions: ${cdp.pageErrors.length}`)
  if (!consoleClean) {
    console.log('Console errors observed:')
    for (const e of [...new Set(cdp.consoleErrors)].concat(cdp.pageErrors).slice(0, 10)) console.log('  • ' + e.slice(0, 200))
  }
  if (fails.length) {
    console.log('\nFailing-case evidence is in the table above.')
  }

  ws.close()
  return fails.length > 0 ? 1 : 0
}

let exitCode = 2
try {
  exitCode = await main()
} catch (err) {
  console.error('\nSUITE ERROR:', err?.stack ?? err)
  exitCode = 2
} finally {
  killChrome()
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best effort */ }
}
process.exit(exitCode)
