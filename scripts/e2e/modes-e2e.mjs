#!/usr/bin/env node
// End-to-end check of every run mode and turn route, in the real UI, against
// fake llama.cpp servers (scripts/e2e/fake-llama.mjs). No models needed.
//
//   npm run e2e:modes
//
// Starts the fake servers and a Vite dev server on 127.0.0.1:5199, drives the
// app with Playwright, and asserts what each route must show and record:
// routing verdicts, honest notices, timing buckets that add up, server facts
// relayed onto model calls, pending-edit adjudication, mode-scoped health.
// Exits non-zero on any failed check.
//
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright
// install chromium` if it is not already available) and free ports
// 8080/8083/8085/8086/5199 — stop real model servers first.

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAKE_PORTS, startFakeLlama } from './fake-llama.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_PORT = 5199
const APP = `http://127.0.0.1:${APP_PORT}/`
const STORAGE_KEY = 'liquidscribe.workspace.v1'
const MODE_KEY = 'liquidscribe.runmode.v1'

let chromium
try {
  ;({ chromium } = createRequire(import.meta.url)('playwright'))
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium')
  process.exit(2)
}

// --- harness -------------------------------------------------------------------

const checks = []
function check(scope, name, ok, detail = '') {
  checks.push({ scope, name, ok: Boolean(ok), detail })
}

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`timed out waiting for ${url}`)
}

/** Sum of the timing buckets that feed `total` — they must add up. */
function bucketSum(t) {
  return (t.route ?? 0) + (t.generate ?? 0) + (t.critic ?? 0) + (t.execute ?? 0) + (t.chat ?? 0) + (t.asr ?? 0)
}

async function openSession(browser, mode) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript(
    ({ mode, modeKey }) => {
      if (!sessionStorage.getItem('e2e-init')) {
        localStorage.clear()
        localStorage.setItem(modeKey, mode)
        sessionStorage.setItem('e2e-init', '1')
      }
    },
    { mode, modeKey: MODE_KEY },
  )
  await page.goto(APP)
  await page.waitForSelector('#command-input')
  await page.waitForTimeout(1500) // first health probe
  return { page, pageErrors }
}

/** Send one command, wait for the turn and the debounced save, return what was recorded. */
async function send(page, text) {
  const before = await page.locator('.message-row').count()
  await page.fill('#command-input', text)
  await page.press('#command-input', 'Enter')
  await page.waitForFunction(
    (n) =>
      !document.querySelector('#command-input')?.disabled &&
      document.querySelectorAll('.message-row').length > n,
    before,
    { timeout: 20_000 },
  )
  await page.waitForTimeout(1600) // past the app's debounced persistence
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), STORAGE_KEY)
  const transcript = await page.$$eval('.message-row', (rows) =>
    rows.map((row) => row.innerText.replace(/\s+/g, ' ').trim()),
  )
  return { run: state.runs?.[0] ?? null, newMessages: transcript.slice(before).join(' | ') }
}

const text = async (page, selector) => (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ')

// --- scenarios -----------------------------------------------------------------

async function audioMode(browser) {
  const scope = 'audio'
  const { page, pageErrors } = await openSession(browser, 'audio')

  const status = await text(page, '.statusbar')
  check(scope, 'health counts only the mode’s servers (unused 8083 is loading)', /Models up 3\/3/.test(status), status)
  const unused = await page.$$eval('.wiring-endpoint', (rows) => rows.map((r) => r.innerText).join(' | '))
  check(scope, 'unused legacy server is shown as not used', /8083[\s\S]*not used in this mode/.test(unused), unused)

  let r = await send(page, 'hello there')
  check(scope, 'chat-only: d1 routes conversational', r.run?.d1Route?.intent === 'conversational', JSON.stringify(r.run?.d1Route))
  check(scope, 'chat-only: unrun stages are skipped, not fallback', r.run?.runtime?.worker === 'skipped' && r.run?.runtime?.critic === 'skipped', JSON.stringify(r.run?.runtime))
  check(scope, 'chat-only: no "nothing changed" notice', !/Nothing was changed/.test(r.newMessages), r.newMessages)

  r = await send(page, 'append a mock line')
  const t = r.run?.timings ?? {}
  check(scope, 'routed edit: applied', r.run?.status === 'verified', r.run?.status)
  check(scope, 'routed edit: timing buckets add up to the total', Math.abs(bucketSum(t) - t.total) < 0.2, JSON.stringify(t))
  check(scope, 'routed edit: d1 probabilities + prompt tokens kept', !!r.run?.d1Check?.probabilities?.destructiveSafety && r.run?.d1Check?.promptTokens > 0, JSON.stringify(r.run?.d1Check))
  const exchanges = r.run?.exchanges ?? []
  check(scope, 'routed edit: model calls carry served model + tok/s', exchanges.length >= 2 && exchanges.every((e) => e.servedModel && e.response?.timings?.tokensPerSecond), JSON.stringify(exchanges.map((e) => [e.label, e.servedModel, e.response?.timings])))
  check(scope, 'routed edit: output tokens are the servers’ sum', r.run?.outputTokens === exchanges.reduce((s, e) => s + (e.response?.outputTokens ?? 0), 0), String(r.run?.outputTokens))

  r = await send(page, 'maybe tweak the intro')
  check(scope, 'low-confidence edit: not routed', r.run?.d1Route?.routesToWorker === false && r.run?.d1Route?.confidence === 0.3, JSON.stringify(r.run?.d1Route))
  check(scope, 'low-confidence edit: says nothing changed', /Nothing was changed: d1 read this as an insert request but with low confidence \(0\.30/.test(r.newMessages), r.newMessages)

  r = await send(page, 'd1down add a line')
  check(scope, 'd1 down: route is a fallback with the error', r.run?.runtime?.route === 'fallback' && /HTTP 500/.test(r.run?.d1Route?.error ?? ''), JSON.stringify(r.run?.d1Route))
  check(scope, 'd1 down: says the router gave no answer', /router \(d1\) gave no usable answer/.test(r.newMessages), r.newMessages)

  r = await send(page, 'disapprove and append a line')
  check(scope, 'disapproved edit: held as pending', r.run?.status === 'pending', r.run?.status)
  check(scope, 'disapproved edit: delegation card says held for you', /Held for you/.test(r.newMessages), r.newMessages)
  const heldRunId = r.run?.id
  await page.click('button[aria-label="Apply proposed edit"]')
  await page.waitForTimeout(1600)
  const after = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), STORAGE_KEY)
  const resolved = after.runs?.find((run) => run.id === heldRunId)
  check(scope, 'apply: the held run becomes applied', resolved?.status === 'verified' && resolved?.resolution === 'applied' && !!resolved?.execution?.snapshotId, JSON.stringify({ status: resolved?.status, resolution: resolved?.resolution }))

  const context = await page.$$eval('.context-row', (rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ')).join(' | '))
  check(scope, 'context budget uses the servers’ reported n_ctx', /\/ 64K/.test(context), context)
  check(scope, 'no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  await page.close()
}

async function omniMode(browser) {
  const scope = 'omni (legacy)'
  const { page, pageErrors } = await openSession(browser, 'omni')
  const status = await text(page, '.statusbar')
  check(scope, 'a loading server reads as loading, not down', /1 of 3 models loading/.test(status), status)
  await fetch('http://127.0.0.1:8083/__ready')
  await page.click('button[aria-label="Re-probe model endpoints"]')
  await page.waitForTimeout(800)

  let r = await send(page, 'hello there')
  check(scope, 'answer: booked as chat time only', r.run?.status === 'conversational' && (r.run?.timings?.route ?? 0) === 0 && r.run?.timings?.chat > 0, JSON.stringify(r.run?.timings))

  r = await send(page, 'append a mock line')
  const t = r.run?.timings ?? {}
  check(scope, 'delegation: applied', r.run?.status === 'verified', r.run?.status)
  check(scope, 'delegation: Omni call is route time, not also chat', t.route > 0 && !t.chat, JSON.stringify(t))
  check(scope, 'delegation: buckets add up', Math.abs(bucketSum(t) - t.total) < 0.2, JSON.stringify(t))
  check(scope, 'no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  await page.close()
}

async function workerMode(browser, mode) {
  const scope = mode
  const { page, pageErrors } = await openSession(browser, mode)
  let r = await send(page, 'what about Q4')
  check(scope, 'chat: 1.7B answers, no model route claimed', r.run?.status === 'conversational' && r.run?.runtime?.route === 'skipped', JSON.stringify(r.run?.runtime))

  r = await send(page, 'append a mock line')
  const t = r.run?.timings ?? {}
  check(scope, 'tool call: one 1.7B request booked once (generate, not also chat)', t.generate > 0 && !t.chat, JSON.stringify(t))
  check(scope, 'tool call: buckets add up', Math.abs(bucketSum(t) - t.total) < 0.2, JSON.stringify(t))
  if (mode === 'worker-d1') {
    check(scope, 'tool call: d1 approves and it applies', r.run?.status === 'verified', r.run?.status)
  } else {
    check(scope, 'tool call: held (no decision model)', r.run?.status === 'pending' && r.run?.hold?.kind === 'no-decision-model', JSON.stringify(r.run?.hold))
    const chip = await text(page, '.pending-verdict')
    check(scope, 'pending chip does not blame d1', /No safety check in this mode/.test(chip), chip)
  }
  check(scope, 'no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  await page.close()
}

// --- main ----------------------------------------------------------------------

const busy = []
for (const port of [...FAKE_PORTS, APP_PORT]) if (!(await portFree(port))) busy.push(port)
if (busy.length) {
  console.error(`Ports in use: ${busy.join(', ')}. Stop real model servers / dev servers first.`)
  process.exit(2)
}

const fake = await startFakeLlama()
const vite = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore' },
)
let browser
try {
  await waitForHttp(APP)
  browser = await chromium.launch()
  await audioMode(browser)
  await omniMode(browser)
  await workerMode(browser, 'worker-d1')
  await workerMode(browser, 'lowram')
} catch (error) {
  check('harness', 'run completed', false, error instanceof Error ? error.message : String(error))
} finally {
  await browser?.close()
  vite.kill()
  await fake.close()
}

let failed = 0
for (const c of checks) {
  if (!c.ok) failed += 1
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  [${c.scope}] ${c.name}${c.ok ? '' : `\n      ${c.detail}`}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
