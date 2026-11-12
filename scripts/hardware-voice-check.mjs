#!/usr/bin/env node
/**
 * LiquidScribe real-hardware voice pass.
 *
 * Unlike scripts/qa-suite.mjs this script NEVER fakes media: Chrome gets
 * --use-fake-ui-for-media-stream (auto-grant) only, so getUserMedia captures
 * the physical default PulseAudio source, and TTS playback goes out the
 * physical default sink. The acoustic path is measured by recording the real
 * microphone with parecord while audio plays through the real speakers.
 *
 * Mic pass
 *   1. Synthesize a natural-voice command with the Omni model's own /tts.
 *   2. Click the app's mic, play the command out loud, wait for the app's VAD
 *      auto-stop, then check the Omni transcript and the resulting note edit.
 *
 * Speaker pass
 *   1. Enable spoken replies, ask for a long reply, record the real mic.
 *   2. Click "Stop audio" mid-sentence; verify the acoustic level collapses.
 *   3. Mute spoken replies; ask again; verify nothing is audible.
 *
 * Artifacts land in /tmp/lscribe-voice/ (override with VOICE_OUT_DIR).
 *
 * Usage:
 *   node scripts/hardware-voice-check.mjs [--skip-mic] [--skip-speaker]
 *        [--headful] [--keep-chrome]
 *
 * Requires the trinity (omni :8083, d1 :8085, worker :8080) and Vite :5173.
 */
import { spawn, execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const APP_URL = process.env.VOICE_APP_URL ?? 'http://localhost:5173'
const CDP_PORT = Number(process.env.VOICE_CDP_PORT ?? 9231)
const STORAGE_KEY = 'liquidscribe.workspace.v1'
const OUT_DIR = process.env.VOICE_OUT_DIR ?? '/tmp/lscribe-voice'
const RUN_TIMEOUT_MS = Number(process.env.VOICE_RUN_TIMEOUT_MS ?? 150_000)
const TTS_URL = process.env.VOICE_TTS_URL ?? 'http://127.0.0.1:8083/tts'

// "row" must be spoken: this is the word the earlier espeak run heard as "rose".
const PHRASE = process.env.VOICE_PHRASE ?? 'Update the Q3 revenue row status to Final'
const LONG_REPLY_PROMPT =
  process.env.VOICE_LONG_PROMPT ?? 'tell me a story about a lighthouse, three paragraphs'
const QUIET_REPLY_PROMPT =
  process.env.VOICE_QUIET_PROMPT ?? 'tell me a short story about a fishing boat'

const argv = new Set(process.argv.slice(2))
const SKIP_MIC = argv.has('--skip-mic')
const SKIP_SPEAKER = argv.has('--skip-speaker')
const HEADFUL = argv.has('--headful') || process.env.VOICE_CHROME_MODE === 'headful'
const KEEP_CHROME = argv.has('--keep-chrome')

mkdirSync(OUT_DIR, { recursive: true })

// ------------------------------------------------------------------ utils ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, args, { timeout = 60_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      reject(new Error(`${cmd} timed out`))
    }, timeout)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} exited ${code ?? signal}: ${stderr.trim().slice(0, 400)}`))
    })
    if (input !== undefined) { child.stdin.end(input) }
  })
}

function which(bin) {
  try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim() } catch { return null }
}

function requireBin(bin) {
  const found = which(bin)
  if (!found) throw new Error(`required binary not found: ${bin}`)
  return found
}

requireBin('parecord')
requireBin('paplay')
requireBin('pactl')
requireBin('ffmpeg')

// ------------------------------------------------------------- wav / pcm ---

/** Minimal RIFF parser → { sampleRate, channels, bits, dataBytes, durationSec }. */
function readWavInfo(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, buf.length - body) }
    }
    offset = body + size + (size & 1)
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data chunk')
  return {
    ...fmt,
    dataOffset: data.offset,
    dataBytes: data.size,
    durationSec: data.size / (fmt.sampleRate * fmt.channels * (fmt.bits / 8)),
  }
}

/** Windowed RMS/peak analysis of mono s16le PCM. dBFS values (0 = full scale). */
function analyzePcm(buf, sampleRate = 48_000, windowMs = 50) {
  const total = buf.length >> 1
  const samples = new Int16Array(buf.buffer, buf.byteOffset, total)
  const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000))
  const windows = []
  for (let start = 0; start + win <= total; start += win) {
    let sum = 0
    let peak = 0
    for (let i = start; i < start + win; i += 1) {
      const v = samples[i] / 32768
      sum += v * v
      const a = Math.abs(v)
      if (a > peak) peak = a
    }
    const rms = Math.sqrt(sum / win)
    windows.push({
      t: (start + win / 2) / sampleRate,
      rms,
      rmsDb: rms > 0 ? 20 * Math.log10(rms) : -120,
      peakDb: peak > 0 ? 20 * Math.log10(peak) : -120,
    })
  }
  return { windows, sampleRate, durationSec: total / sampleRate, sampleCount: total }
}

function percentile(values, p) {
  if (!values.length) return -120
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

/** Median window RMS (dBFS) inside a time span. */
function floorDb(analysis, fromSec, toSec) {
  const vals = analysis.windows
    .filter((w) => w.t >= fromSec && w.t <= toSec)
    .map((w) => w.rmsDb)
  return percentile(vals, 50)
}

/** Contiguous audible segments above threshold; gaps <= 120 ms are bridged. */
function findSegments(analysis, thresholdDb, { minDurationMs = 150, maxGapMs = 120 } = {}) {
  const windows = analysis.windows
  const segments = []
  let current = null
  for (const w of windows) {
    if (w.rmsDb >= thresholdDb) {
      if (!current) current = { start: w.t, end: w.t, peakDb: w.peakDb, maxRmsDb: w.rmsDb }
      else {
        if (w.t - current.end > maxGapMs / 1000) {
          segments.push(current)
          current = { start: w.t, end: w.t, peakDb: w.peakDb, maxRmsDb: w.rmsDb }
        } else {
          current.end = w.t
          if (w.peakDb > current.peakDb) current.peakDb = w.peakDb
          if (w.rmsDb > current.maxRmsDb) current.maxRmsDb = w.rmsDb
        }
      }
    } else if (current) {
      segments.push(current)
      current = null
    }
  }
  if (current) segments.push(current)
  return segments
    .filter((s) => (s.end - s.start) * 1000 >= minDurationMs)
    .map((s) => ({ ...s, durationSec: Number((s.end - s.start).toFixed(2)) }))
}

/** First time after `afterSec` where `holdMs` of windows stay below threshold. */
function collapseTime(analysis, afterSec, thresholdDb, holdMs = 300) {
  const windows = analysis.windows.filter((w) => w.t >= afterSec)
  const need = Math.ceil(holdMs / 50)
  for (let i = 0; i + need <= windows.length; i += 1) {
    let quiet = true
    for (let j = 0; j < need; j += 1) if (windows[i + j].rmsDb >= thresholdDb) { quiet = false; break }
    if (quiet) return windows[i].t
  }
  return null
}

function pcmToWav(pcmPath, wavPath, sampleRate = 48_000) {
  return run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', '1',
    '-i', pcmPath, '-c:a', 'pcm_s16le', wavPath,
  ])
}

// ------------------------------------------------------------- parecord ---

async function startRecording(pcmPath) {
  const child = spawn('parecord', [
    '--format=s16le', '--rate=48000', '--channels=1', '--file-format=raw', pcmPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  await sleep(250)
  return {
    child,
    pcmPath,
    startedAt: Date.now(),
    async stop() {
      if (child.exitCode !== null) return
      const done = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      await Promise.race([done, sleep(4000)])
      if (child.exitCode === null) { try { child.kill('SIGKILL') } catch { /* gone */ } }
      if (stderr.trim()) console.error(`  parecord stderr: ${stderr.trim().slice(0, 200)}`)
    },
  }
}

// ------------------------------------------------------- sink bookkeeping ---

function readSinkState() {
  const vol = execFileSync('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { encoding: 'utf8' })
  const mute = execFileSync('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], { encoding: 'utf8' })
  const nums = [...vol.matchAll(/(\d+) \//g)].map((m) => Number(m[1]))
  const pcts = [...vol.matchAll(/(\d+)%/g)].map((m) => Number(m[1]))
  return {
    rawVolume: vol.trim(),
    rawMute: mute.trim(),
    left: nums[0] ?? null,
    right: nums[1] ?? nums[0] ?? null,
    percent: pcts[0] ?? null,
    muted: /yes/i.test(mute),
  }
}

function restoreSink(state) {
  try {
    if (state.left != null) {
      execFileSync('pactl', ['set-sink-volume', '@DEFAULT_SINK@', String(state.left), String(state.right ?? state.left)])
    }
    execFileSync('pactl', ['set-sink-mute', '@DEFAULT_SINK@', state.muted ? '1' : '0'])
  } catch (err) {
    console.error('  WARN could not restore sink state:', err.message)
  }
}

// -------------------------------------------------------------- Chrome -----

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean)

function findChrome() {
  for (const cand of CHROME_CANDIDATES) {
    if (cand.includes('/')) { if (existsSync(cand)) return cand }
    else { try { return execFileSync('which', [cand], { encoding: 'utf8' }).trim() } catch { /* next */ } }
  }
  return null
}

const chromeBin = findChrome()
if (!chromeBin) {
  console.error('No Chrome/Chromium binary found (set CHROME_PATH).')
  process.exit(2)
}

const chromeArgs = [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'liquidscribe-voice-chrome-'))}`,
  '--no-first-run',
  '--no-default-browser-check',
  // Auto-grant the permission prompt but keep the REAL default device:
  // deliberately no --use-fake-device-for-media-stream / --use-file-for-...
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
]
if (!HEADFUL) chromeArgs.push('--headless=new', '--disable-gpu')
else chromeArgs.push('--start-maximized')
chromeArgs.push('about:blank')

const chrome = spawn(chromeBin, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
let chromeExited = null
let chromeStderr = ''
chrome.stderr.on('data', (d) => { chromeStderr += d })
chrome.on('exit', (code, signal) => { chromeExited = { code, signal } })

function killChrome() {
  if (chromeExited || chrome.exitCode !== null) return
  try { chrome.kill('SIGKILL') } catch { /* already gone */ }
}

process.on('exit', killChrome)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killChrome()
    try { rmSync(chromeArgs[1].slice('--user-data-dir='.length), { recursive: true, force: true }) } catch { /* best effort */ }
    process.exit(130)
  })
}

// ----------------------------------------------------------------- CDP -----

async function waitDevtools() {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (res.ok) return
    } catch { /* not up */ }
    if (chromeExited) throw new Error(`Chrome exited early: ${JSON.stringify(chromeExited)}; ${chromeStderr.slice(0, 400)}`)
    await sleep(150)
  }
  throw new Error('DevTools endpoint never came up on port ' + CDP_PORT)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.pageErrors = []
    this.requests = []
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
        this.consoleErrors.push(`[log] ${msg.params.entry.text} (${msg.params.entry.url ?? ''})`)
      } else if (msg.method === 'Network.requestWillBeSent') {
        this.requests.push({
          at: Date.now(),
          id: msg.params.requestId,
          method: msg.params.request.method,
          url: msg.params.request.url,
        })
      } else if (msg.method === 'Network.responseReceived') {
        const known = this.requests.find((r) => r.id === msg.params.requestId)
        if (known) {
          known.status = msg.params.response.status
          known.mime = msg.params.response.mimeType
        }
      } else if (msg.method === 'Network.loadingFailed') {
        const known = this.requests.find((r) => r.id === msg.params.requestId)
        if (known) known.failed = msg.params.errorText
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
      }, 90_000)
    })
  }
}

// ------------------------------------------------------ audio preflight -----

async function synthesize(text, outPath) {
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, response_format: 'wav' }),
  })
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('TTS returned empty audio')
  writeFileSync(outPath, buf)
  return { bytes: buf.length, ...readWavInfo(buf) }
}

/**
 * Play a WAV through the real speakers while recording the real mic.
 * Returns acoustic analysis + recording path.
 */
async function acousticPlayback(wavPath, outBase, { tailMs = 700 } = {}) {
  const pcmPath = `${outBase}.pcm`
  const rec = await startRecording(pcmPath)
  const playT0 = Date.now()
  await run('paplay', [wavPath], { timeout: 180_000 })
  const playEnd = Date.now()
  await sleep(tailMs)
  await rec.stop()
  const buf = readFileSync(pcmPath)
  const analysis = analyzePcm(buf)
  const wavOut = `${outBase}.wav`
  await pcmToWav(pcmPath, wavOut)
  // The recorder starts before playback, but PipeWire's capture startup delay
  // varies; a low percentile over the whole take is a robust room floor.
  const preFloor = percentile(analysis.windows.map((w) => w.rmsDb), 10)
  const threshold = Math.max(preFloor + 12, -60)
  const segments = findSegments(analysis, threshold)
  return {
    wavPath: wavOut,
    pcmPath,
    analysis,
    preFloor,
    threshold,
    segments,
    playStartAt: playT0,
    playEndAt: playEnd,
    playbackMs: playEnd - playT0,
  }
}

async function preflightAudible(commandWav) {
  const result = await acousticPlayback(commandWav, path.join(OUT_DIR, 'preflight'), { tailMs: 400 })
  const best = result.segments.sort((a, b) => b.peakDb - a.peakDb)[0] ?? null
  return { ...result, best }
}

// ------------------------------------------------------------- app driver ---

function domHelpers(cdp) {
  const evalJs = async (expression) => {
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

  const getWs = () => evalJs(
    `(() => { const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)}); return raw ? JSON.parse(raw) : null })()`,
  )

  async function waitAppReady(timeout = 40_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evalJs(`!!document.querySelector('.composer-mic') && !!document.querySelector('#command-input')`)) {
        await sleep(300)
        if (await evalJs(`!!document.querySelector('.composer-mic') && !!document.querySelector('#command-input')`)) return
      }
      await sleep(200)
    }
    throw new Error('app never became ready (no .composer-mic)')
  }

  async function seedWorkspace(state) {
    const payload = state === null ? 'null' : JSON.stringify(JSON.stringify(state))
    await evalJs(
      state === null
        ? `localStorage.removeItem(${JSON.stringify(STORAGE_KEY)})`
        : `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${payload})`,
    )
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(800)
    await waitAppReady()
  }

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

  async function micState() {
    return evalJs(`(() => {
      const mic = document.querySelector('.composer-mic')
      const status = document.querySelector('.statusbar')?.textContent ?? ''
      const stop = [...document.querySelectorAll('.session-header button')].find((b) => b.textContent.includes('Stop audio'))
      return {
        micOn: !!mic && mic.classList.contains('is-active'),
        asrBusy: !!mic && mic.classList.contains('is-busy'),
        micLabel: mic?.getAttribute('aria-label') ?? null,
        micDisabled: !!mic?.disabled,
        statusHasRec: /REC 16 kHz/.test(status),
        statusHasTranscribing: /· transcribing/.test(status),
        stopAudio: stop ? { disabled: stop.disabled, title: stop.title } : null,
        speakerOn: !!document.querySelector('[aria-label="Mute spoken replies"]'),
      }
    })()`)
  }

  async function runsInfo() {
    return evalJs(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
      const ws = raw ? JSON.parse(raw) : null
      const runs = (ws && Array.isArray(ws.runs)) ? ws.runs : []
      const last = runs[0] ?? null
      return { count: runs.length, status: last ? last.status : null, command: last ? last.command : null,
               runtime: last ? last.runtime ?? null : null, at: last ? last.at ?? null : null }
    })()`)
  }

  const TERMINAL = new Set(['verified', 'rejected', 'clarify', 'conversational', 'failed'])

  async function waitForRun({ timeout = RUN_TIMEOUT_MS, expectMore = null } = {}) {
    const before = await runsInfo()
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const info = await runsInfo()
      const more = expectMore == null ? info.count > before.count : info.count > expectMore
      if (more && TERMINAL.has(info.status)) return { ...info, timedOut: false }
      await sleep(250)
    }
    return { ...(await runsInfo()), timedOut: true }
  }

  async function voiceTranscripts() {
    return evalJs(`(() => [...document.querySelectorAll('.message-row.message-user')].map((row) => ({
      source: row.querySelector('.message-user-source')?.textContent?.trim() ?? '',
      text: row.querySelector('.message-user-bubble')?.textContent ?? '',
    })).filter((m) => /VOICE/.test(m.source)))()`)
  }

  async function lastReply() {
    return evalJs(`(() => {
      const els = document.querySelectorAll('.session-transcript .message-assistant .message-assistant-text')
      return els.length ? els[els.length - 1].textContent : ''
    })()`)
  }

  async function note() {
    const ws = await getWs()
    return ws?.note ?? null
  }

  async function screenshot(name) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const out = path.join(OUT_DIR, name)
      writeFileSync(out, Buffer.from(shot.data, 'base64'))
      return out
    } catch (err) {
      console.error(`  WARN screenshot ${name} failed: ${err.message}`)
      return null
    }
  }

  return {
    evalJs, getWs, waitAppReady, seedWorkspace, submitCommand, micState,
    runsInfo, waitForRun, voiceTranscripts, lastReply, note, screenshot,
  }
}

// -------------------------------------------------------------- word diff ---

const normalizeWords = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9'$.\s-]/g, ' ')
    .replace(/[.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Word-level Levenshtein alignment producing a human readable diff. */
function wordDiff(expected, actual) {
  const a = normalizeWords(expected)
  const b = normalizeWords(actual)
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i += 1) dp[i][0] = i
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  let i = a.length
  let j = b.length
  const ops = []
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ op: '=', word: a[i - 1] }); i -= 1; j -= 1
    } else if (j > 0 && (i === 0 || dp[i][j - 1] <= dp[i - 1][j])) {
      const cost = i > 0 && dp[i][j] === dp[i - 1][j - 1] + 1
      ops.push({ op: cost ? '~' : '+', word: b[j - 1] }); j -= 1
      if (cost) i -= 1
    } else {
      ops.push({ op: '-', word: a[i - 1] }); i -= 1
    }
  }
  ops.reverse()
  const errors = ops.filter((o) => o.op !== '=').length
  const wer = a.length ? errors / a.length : 0
  return {
    expectedWords: a,
    actualWords: b,
    ops,
    errors,
    wer: Number(wer.toFixed(3)),
    diff: ops.map((o) => (o.op === '=' ? o.word : `${o.op}${o.word}`)).join(' '),
  }
}

// --------------------------------------------------------------- results ---

const results = []
function record(id, title, ok, evidence) {
  results.push({ id, title, status: ok ? 'PASS' : 'FAIL', evidence })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${title}`)
  console.log(`         ${evidence}`)
}

function failing(id, title, evidence) {
  record(id, title, false, evidence)
}

// ------------------------------------------------------------------ main ---

async function main() {
  const summary = {
    startedAt: new Date().toISOString(),
    phrase: PHRASE,
    appUrl: APP_URL,
    chromeMode: HEADFUL ? 'headful' : 'headless',
    chrome: execFileSync(chromeBin, ['--version'], { encoding: 'utf8' }).trim(),
    sink: execFileSync('pactl', ['get-default-sink'], { encoding: 'utf8' }).trim(),
    source: execFileSync('pactl', ['get-default-source'], { encoding: 'utf8' }).trim(),
    sinkStateBefore: null,
    sinkStateUsed: null,
    micPass: null,
    speakerPass: null,
    consoleErrors: [],
    pageErrors: [],
    requests: [],
  }

  await waitDevtools()

  const created = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(APP_URL)}`,
    { method: 'PUT' },
  ).then((r) => (r.ok ? r.json() : null))
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
  await cdp.send('Network.enable')

  const app = domHelpers(cdp)
  await app.waitAppReady()
  await app.seedWorkspace(null)

  // Wait for the runtime health probe so the app knows Omni is live.
  for (let i = 0; i < 60; i += 1) {
    const live = await app.evalJs(`/Models up (\\d+)\\/\\1\\b/.test(document.querySelector('.statusbar')?.textContent ?? '')`)
    if (live) break
    await sleep(250)
  }

  // Sink: remember exact state, force audible level, restore in finally.
  summary.sinkStateBefore = readSinkState()
  try {
    execFileSync('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '0'])
    if ((summary.sinkStateBefore.percent ?? 0) < 90) {
      execFileSync('pactl', ['set-sink-volume', '@DEFAULT_SINK@', '100%'])
    }
  } catch (err) {
    console.error('  WARN sink prep failed:', err.message)
  }
  summary.sinkStateUsed = readSinkState()
  console.log(`Sink: ${summary.sink} @ ${summary.sinkStateUsed.percent}% (was ${summary.sinkStateBefore.percent}%, muted=${summary.sinkStateBefore.muted})`)
  console.log(`Source: ${summary.source}`)

  const commandWav = path.join(OUT_DIR, 'command.wav')
  const ttsInfo = await synthesize(PHRASE, commandWav)
  console.log(`\nSynthesized natural-voice command: ${ttsInfo.durationSec.toFixed(2)}s, ${ttsInfo.sampleRate} Hz, ${ttsInfo.channels}ch → ${commandWav}`)

  // Acoustic preflight: make sure the speakers are actually audible to the mic.
  console.log('\nAcoustic preflight (real speaker → real mic)…')
  let pre = await preflightAudible(commandWav)
  summary.preflight = {
    floorDb: Number(pre.preFloor.toFixed(1)),
    peakDb: pre.best ? Number(pre.best.peakDb.toFixed(1)) : null,
    maxRmsDb: pre.best ? Number(pre.best.maxRmsDb.toFixed(1)) : null,
    segments: pre.segments,
    recording: pre.wavPath,
  }
  console.log(`  floor ${pre.preFloor.toFixed(1)} dBFS · peak ${pre.best ? pre.best.peakDb.toFixed(1) : '—'} dBFS · audible ${pre.segments.length} segment(s)`)
  if (!pre.best || pre.best.peakDb < pre.preFloor + 10) {
    console.log('  level low → raising sink to 130% and retrying preflight')
    try { execFileSync('pactl', ['set-sink-volume', '@DEFAULT_SINK@', '130%']) } catch (err) { console.error('  WARN volume raise failed:', err.message) }
    summary.sinkStateUsed = readSinkState()
    pre = await preflightAudible(commandWav)
    summary.preflightRetry = {
      floorDb: Number(pre.preFloor.toFixed(1)),
      peakDb: pre.best ? Number(pre.best.peakDb.toFixed(1)) : null,
      maxRmsDb: pre.best ? Number(pre.best.maxRmsDb.toFixed(1)) : null,
      segments: pre.segments,
      recording: pre.wavPath,
      sinkPercent: summary.sinkStateUsed.percent,
    }
    console.log(`  retry: floor ${pre.preFloor.toFixed(1)} dBFS · peak ${pre.best ? pre.best.peakDb.toFixed(1) : '—'} dBFS`)
  }

  // ----------------------------------------------------------- mic pass ---
  if (!SKIP_MIC) {
    console.log('\n=== MIC PASS — real mic captures a real spoken command ===')
    await app.seedWorkspace(null)
    // Give Chrome's audio service a moment to settle after reload.
    await sleep(800)

    const transcriptBefore = await app.voiceTranscripts()
    const runsBefore = await app.runsInfo()
    const noteBefore = await app.note()
    const ttsRequestsBefore = cdp.requests.filter((r) => r.url.includes(':8083/tts')).length
    const asrRequestsBefore = cdp.requests.filter((r) => r.url.includes('/v1/audio/transcriptions')).length

    // Click the app's own mic button.
    const micStartAt = Date.now()
    await app.evalJs(`document.querySelector('.composer-mic').click()`)
    let mic = await app.micState()
    const micDeadline = Date.now() + 10_000
    while (!mic.micOn && Date.now() < micDeadline) {
      await sleep(100)
      mic = await app.micState()
    }
    const micReadyMs = Date.now() - micStartAt
    if (!mic.micOn) {
      failing('M0', 'app mic enters capturing state on real microphone', `micState=${JSON.stringify(mic)}`)
      throw new Error('app never entered mic capture state (getUserMedia failed?)')
    }
    console.log(`  app mic capturing after ${micReadyMs}ms (${mic.micLabel})`)
    await app.screenshot('mic-pass-listening.png')

    // Record the physical mic for evidence and play the phrase to the room.
    const rec = await startRecording(path.join(OUT_DIR, 'mic-pass.pcm'))
    await sleep(300)
    const playT0 = Date.now()
    await run('paplay', [commandWav], { timeout: 180_000 })
    const playEnd = Date.now()

    // Watch the app's auto-stop: micOn must flip off without another click.
    let stoppedAt = null
    let stoppedState = null
    const stopDeadline = Date.now() + 30_000
    while (Date.now() < stopDeadline) {
      const state = await app.micState()
      if (!state.micOn) { stoppedAt = Date.now(); stoppedState = state; break }
      await sleep(100)
    }
    const autoStopLatencyMs = stoppedAt ? stoppedAt - playEnd : null
    console.log(`  phrase played ${playEnd - playT0}ms; auto-stop ${autoStopLatencyMs == null ? 'NEVER' : autoStopLatencyMs + 'ms after playback end'}`)
    await app.screenshot('mic-pass-transcribing.png')

    // Wait for the Omni ASR request + voice transcript, then the pipeline run.
    let asrRequests = cdp.requests.filter((r) => r.url.includes('/v1/audio/transcriptions')).length
    const asrDeadline = Date.now() + 45_000
    while (asrRequests <= asrRequestsBefore && Date.now() < asrDeadline) {
      await sleep(200)
      asrRequests = cdp.requests.filter((r) => r.url.includes('/v1/audio/transcriptions')).length
    }

    let transcripts = []
    const txDeadline = Date.now() + 45_000
    while (Date.now() < txDeadline) {
      transcripts = await app.voiceTranscripts()
      if (transcripts.length > transcriptBefore.length && transcripts.at(-1)?.text) break
      await sleep(250)
    }
    const voiceMsg = transcripts.at(-1) ?? null
    const transcript = voiceMsg?.text ?? ''

    const micRun = await app.waitForRun({ expectMore: runsBefore.count, timeout: RUN_TIMEOUT_MS })
    await sleep(1200)
    const noteAfter = await app.note()
    await app.screenshot('mic-pass-after-run.png')

    // Give the mic recorder a moment past the transcript, then stop.
    await sleep(500)
    await rec.stop()
    const recBuf = readFileSync(path.join(OUT_DIR, 'mic-pass.pcm'))
    const recAnalysis = analyzePcm(recBuf)
    const recWav = path.join(OUT_DIR, 'mic-recording.wav')
    await pcmToWav(path.join(OUT_DIR, 'mic-pass.pcm'), recWav)
    const recFloor = floorDb(recAnalysis, 0, 0.25)
    const recSegments = findSegments(recAnalysis, Math.max(recFloor + 12, -60))
    const recPeakDb = recAnalysis.windows.length
      ? Math.max(...recAnalysis.windows.map((w) => w.peakDb))
      : -120

    // Acoustic phrase timing (how long the room actually heard it).
    const acousticSeg = recSegments.sort((a, b) => b.durationSec - a.durationSec)[0] ?? null

    const diff = wordDiff(PHRASE, transcript)
    const hasRow = /\brow\b/i.test(transcript)
    const q3LineBefore = String(noteBefore ?? '').split('\n').find((l) => /^\|\s*Q3\s*\|/.test(l)) ?? null
    const q3LineAfter = String(noteAfter ?? '').split('\n').find((l) => /^\|\s*Q3\s*\|/.test(l)) ?? null
    const noteChanged = noteAfter !== noteBefore
    const statusLanded = q3LineAfter != null && /Final/i.test(q3LineAfter) && !/Final/i.test(q3LineBefore ?? '')
    const ttsRequestsAfterMic = cdp.requests.filter((r) => r.url.includes(':8083/tts')).length - ttsRequestsBefore

    summary.micPass = {
      micReadyMs,
      playbackMs: playEnd - playT0,
      audioDurationSec: ttsInfo.durationSec,
      autoStopLatencyMs,
      autoStopState: stoppedState,
      asrRequests: asrRequests - asrRequestsBefore,
      transcript,
      transcriptSource: voiceMsg?.source ?? null,
      transcriptWordDiff: diff,
      hasRow,
      run: { status: micRun.status, command: micRun.command, runtime: micRun.runtime, timedOut: micRun.timedOut, count: micRun.count },
      noteChanged,
      q3LineBefore,
      q3LineAfter,
      statusLanded,
      recording: {
        file: recWav,
        durationSec: Number(recAnalysis.durationSec.toFixed(2)),
        floorDb: Number(recFloor.toFixed(1)),
        peakDb: Number(recPeakDb.toFixed(1)),
        acousticSegments: recSegments,
        acousticPhraseSec: acousticSeg?.durationSec ?? null,
      },
      ttsRequestsDuringPass: ttsRequestsAfterMic,
    }

    record(
      'M1',
      'capture auto-stops on trailing silence after the spoken phrase',
      autoStopLatencyMs != null && autoStopLatencyMs >= 300 && autoStopLatencyMs <= 6000,
      `auto-stop ${autoStopLatencyMs == null ? 'never fired' : autoStopLatencyMs + 'ms'} after WAV playback end (app VAD threshold 1500ms)` +
        (stoppedState ? `; state after stop: mic=${stoppedState.micLabel}, transcribing=${stoppedState.statusHasTranscribing}` : ''),
    )
    record(
      'M2',
      'The mode\u2019s audio server transcribes the real-mic capture; word "row" preserved',
      Boolean(transcript) && hasRow && diff.wer <= 0.3,
      `transcript=${JSON.stringify(transcript)}; expected=${JSON.stringify(PHRASE)}; WER=${diff.wer} (${diff.errors}/${diff.expectedWords.length} words); hasRow=${hasRow}; diff="${diff.diff}"`,
    )
    record(
      'M3',
      'transcript feeds the command pipeline and the note edit lands',
      micRun.count > runsBefore.count && !micRun.timedOut && noteChanged && (micRun.status === 'verified' || statusLanded),
      `run status=${micRun.status}, timedOut=${micRun.timedOut}, runs ${runsBefore.count}→${micRun.count}, runtime.asr=${micRun.runtime?.asr ?? '-'}, noteChanged=${noteChanged}, Q3 "${q3LineBefore}" → "${q3LineAfter}"`,
    )
  } else {
    console.log('\n(mic pass skipped by --skip-mic)')
  }

  // ------------------------------------------------------- speaker pass ---
  if (!SKIP_SPEAKER) {
    console.log('\n=== SPEAKER PASS — model TTS through real speakers ===')
    await app.seedWorkspace(null)
    await sleep(1000)
    for (let i = 0; i < 60; i += 1) {
      const live = await app.evalJs(`/Models up (\\d+)\\/\\1\\b/.test(document.querySelector('.statusbar')?.textContent ?? '')`)
      if (live) break
      await sleep(250)
    }

    // Speaker on.
    let state = await app.micState()
    if (!state.speakerOn) {
      await app.evalJs(`document.querySelector('[aria-label="Enable spoken replies"]')?.click()`)
      await sleep(250)
      state = await app.micState()
    }
    if (!state.speakerOn) throw new Error('could not enable spoken replies')

    // Pre-playback noise floor (2s).
    const floorPcm = path.join(OUT_DIR, 'speaker-floor.pcm')
    const floorRec = await startRecording(floorPcm)
    await sleep(2000)
    await floorRec.stop()
    const floorAnalysis = analyzePcm(readFileSync(floorPcm))
    const noiseFloor = percentile(floorAnalysis.windows.map((w) => w.rmsDb), 50)
    const noisePeak = Math.max(...floorAnalysis.windows.map((w) => w.peakDb))
    await pcmToWav(floorPcm, path.join(OUT_DIR, 'speaker-floor.wav'))
    const audibleThreshold = Math.max(noiseFloor + 10, -60)
    console.log(`  noise floor ${noiseFloor.toFixed(1)} dBFS (peak ${noisePeak.toFixed(1)}), audible threshold ${audibleThreshold.toFixed(1)} dBFS`)

    const runsBefore = await app.runsInfo()
    const ttsBefore = cdp.requests.filter((r) => r.url.includes(':8083/tts')).length
    const stopPcm = path.join(OUT_DIR, 'tts-reply.pcm')
    const speakerRec = await startRecording(stopPcm)
    const sendAt = Date.now()
    await app.submitCommand(LONG_REPLY_PROMPT)

    // Wait for model TTS playback to actually begin.
    let speaking = false
    let speakingAt = null
    const speakDeadline = Date.now() + 120_000
    while (Date.now() < speakDeadline) {
      const s = await app.micState()
      if (s.stopAudio && !s.stopAudio.disabled && /playback/i.test(s.stopAudio.title ?? '')) {
        speaking = true
        speakingAt = Date.now()
        break
      }
      const runInfo = await app.runsInfo()
      if (runInfo.count > runsBefore.count && TERMINAL_RUN.has(runInfo.status) && Date.now() - sendAt > 8000 && !speaking) {
        // terminal but no playback — keep waiting briefly for TTS fetch
      }
      await sleep(120)
    }
    await app.screenshot('speaker-pass-speaking.png')
    const ttsAfterSend = cdp.requests.filter((r) => r.url.includes(':8083/tts')).length

    let stopClickAt = null
    let playbackObservedMs = 0
    let stopState = null
    if (speaking) {
      // Let a sentence or two play, then hit Stop audio mid-sentence.
      await sleep(1200)
      playbackObservedMs = Date.now() - (speakingAt ?? sendAt)
      stopClickAt = Date.now()
      await app.evalJs(`(() => {
        const b = [...document.querySelectorAll('.session-header button')].find((x) => x.textContent.includes('Stop audio'))
        if (b && !b.disabled) b.click()
      })()`)
      await sleep(200)
      stopState = await app.micState()
      // Record another 2.5s to prove the acoustic collapse.
      await sleep(2500)
    } else {
      stopState = await app.micState()
    }
    await speakerRec.stop()
    const replyRun = await app.waitForRun({ expectMore: runsBefore.count, timeout: RUN_TIMEOUT_MS })
    const reply = await app.lastReply()
    await app.screenshot('speaker-pass-after-stop.png')

    const stopBuf = readFileSync(stopPcm)
    const stopAnalysis = analyzePcm(stopBuf)
    const stopWav = path.join(OUT_DIR, 'tts-reply-capture.wav')
    await pcmToWav(stopPcm, stopWav)

    // Playback is what exceeded the floor after we sent the prompt.
    const sendOffsetSec = (sendAt - speakerRec.startedAt) / 1000
    const playbackSegments = findSegments(stopAnalysis, audibleThreshold)
      .filter((s) => s.end >= sendOffsetSec)
    const mainSeg = playbackSegments.sort((a, b) => b.durationSec - a.durationSec)[0] ?? null
    // Align the parecord timeline to the acoustic playback start rather than
    // trusting parecord's startup latency: DOM reported "speaking" ~when
    // audio.play() began, so click time = acoustic start + DOM delta.
    const firstPlaybackSec = playbackSegments.length
      ? playbackSegments.sort((a, b) => a.start - b.start)[0].start
      : null
    const domClickDeltaSec = speakingAt && stopClickAt ? (stopClickAt - speakingAt) / 1000 : null
    const clickOffsetSec = firstPlaybackSec != null && domClickDeltaSec != null
      ? firstPlaybackSec + domClickDeltaSec
      : stopClickAt ? (stopClickAt - speakerRec.startedAt) / 1000 : null
    const collapseAt = clickOffsetSec != null
      ? collapseTime(stopAnalysis, clickOffsetSec, Math.max(noiseFloor + 6, audibleThreshold - 4), 300)
      : null
    const stopLatencyMs = collapseAt != null && clickOffsetSec != null
      ? Math.round((collapseAt - clickOffsetSec) * 1000)
      : null

    summary.speakerPass = {
      noiseFloorDb: Number(noiseFloor.toFixed(1)),
      noisePeakDb: Number(noisePeak.toFixed(1)),
      audibleThresholdDb: Number(audibleThreshold.toFixed(1)),
      speakingDetected: speaking,
      ttsRequestsAfterSend: ttsAfterSend - ttsBefore,
      replyRun: { status: replyRun.status, timedOut: replyRun.timedOut },
      reply: reply.slice(0, 400),
      playback: mainSeg ? {
        startSec: Number(mainSeg.start.toFixed(2)),
        endSec: Number(mainSeg.end.toFixed(2)),
        durationSec: mainSeg.durationSec,
        peakDb: Number(mainSeg.peakDb.toFixed(1)),
        maxRmsDb: Number(mainSeg.maxRmsDb.toFixed(1)),
        aboveFloorDb: Number((mainSeg.maxRmsDb - noiseFloor).toFixed(1)),
      } : null,
      allSegments: playbackSegments.map((s) => ({
        startSec: Number(s.start.toFixed(2)),
        durationSec: s.durationSec,
        peakDb: Number(s.peakDb.toFixed(1)),
        maxRmsDb: Number(s.maxRmsDb.toFixed(1)),
      })),
      stopClickOffsetSec: clickOffsetSec,
      stopCollapseOffsetSec: collapseAt,
      stopLatencyMs,
      observedBeforeStopMs: playbackObservedMs,
      stopState,
      recording: stopWav,
    }

    record(
      'S1',
      'spoken reply reaches the physical speakers (audible above noise floor)',
      Boolean(mainSeg) && mainSeg.maxRmsDb >= noiseFloor + 10 && mainSeg.peakDb > -45,
      mainSeg
        ? `peak ${mainSeg.peakDb.toFixed(1)} dBFS, RMS ${mainSeg.maxRmsDb.toFixed(1)} dBFS vs floor ${noiseFloor.toFixed(1)} dBFS (+${(mainSeg.maxRmsDb - noiseFloor).toFixed(1)} dB), acoustic duration ${mainSeg.durationSec}s; model /tts requests: ${ttsAfterSend - ttsBefore}`
        : `no acoustic segment above ${audibleThreshold.toFixed(1)} dBFS; speakingDetected=${speaking}; ttsRequests=${ttsAfterSend - ttsBefore}`,
    )
    record(
      'S2',
      'Stop audio mid-sentence collapses playback to the noise floor',
      stopLatencyMs != null && stopLatencyMs <= 1200 && Boolean(mainSeg),
      `stop clicked after ${playbackObservedMs}ms of playback; acoustic level dropped to floor ${stopLatencyMs == null ? 'NEVER' : stopLatencyMs + 'ms'} after the click; state=${JSON.stringify(stopState?.stopAudio)}`,
    )

    // Speaker OFF → next reply must be silent AND request no /tts.
    // Actually flip the top-bar toggle off.
    await app.evalJs(`document.querySelector('[aria-label="Mute spoken replies"]')?.click()`)
    await sleep(300)
    const mutedState = await app.micState()
    const ttsBeforeMute = cdp.requests.filter((r) => r.url.includes(':8083/tts')).length
    const runsBeforeMute = await app.runsInfo()
    const quietPcm = path.join(OUT_DIR, 'speaker-off.pcm')
    const quietRec = await startRecording(quietPcm)
    const quietSendAt = Date.now()
    await app.submitCommand(QUIET_REPLY_PROMPT)
    let quietState = await app.micState()
    // Wait for the reply to finish, then a little extra in case TTS would start late.
    const quietRun = await app.waitForRun({ expectMore: runsBeforeMute.count, timeout: RUN_TIMEOUT_MS })
    await sleep(4000)
    quietState = await app.micState()
    await quietRec.stop()
    const quietBuf = readFileSync(quietPcm)
    const quietAnalysis = analyzePcm(quietBuf)
    const quietWav = path.join(OUT_DIR, 'speaker-off-capture.wav')
    await pcmToWav(quietPcm, quietWav)
    const quietAfterSendSec = (quietSendAt - quietRec.startedAt) / 1000
    const quietSegments = findSegments(quietAnalysis, audibleThreshold)
      .filter((s) => s.end >= quietAfterSendSec)
    const ttsAfterMute = cdp.requests.filter((r) => r.url.includes(':8083/tts')).length - ttsBeforeMute
    const quietFloor = floorDb(quietAnalysis, 0, Math.max(0.5, quietAfterSendSec - 0.1))
    const quietPeak = quietAnalysis.windows.length
      ? Math.max(...quietAnalysis.windows.filter((w) => w.t >= quietAfterSendSec).map((w) => w.peakDb))
      : -120

    summary.speakerOff = {
      speakerOnAfterMuteClick: mutedState.speakerOn,
      speakerOnState: quietState.speakerOn,
      ttsRequests: ttsAfterMute,
      audibleSegments: quietSegments,
      floorDb: Number(quietFloor.toFixed(1)),
      peakDb: Number(quietPeak.toFixed(1)),
      run: { status: quietRun.status, timedOut: quietRun.timedOut },
      recording: quietWav,
    }

    record(
      'S3',
      'speaker toggle off → next reply is silent and requests no model TTS',
      quietState.speakerOn === false && mutedState.speakerOn === false && ttsAfterMute === 0 && quietSegments.length === 0,
      `speakerOnAfterMuteClick=${mutedState.speakerOn}, speakerOn=${quietState.speakerOn}, /tts requests=${ttsAfterMute}, above-floor segments=${quietSegments.length}, peak ${quietPeak.toFixed(1)} dBFS vs floor ${quietFloor.toFixed(1)} dBFS; run=${quietRun.status}`,
    )
  } else {
    console.log('\n(speaker pass skipped by --skip-speaker)')
  }

  summary.consoleErrors = cdp.consoleErrors.slice(0, 20)
  summary.pageErrors = cdp.pageErrors.slice(0, 20)
  summary.requests = cdp.requests
    .filter((r) => /8083|8085|8080/.test(r.url))
    .map((r) => ({ method: r.method, url: r.url, status: r.status ?? null, mime: r.mime ?? null, failed: r.failed ?? null }))
  summary.finishedAt = new Date().toISOString()

  // --------------------------------------------------------------- report ---
  const outJson = path.join(OUT_DIR, 'level-stats.json')
  writeFileSync(outJson, JSON.stringify(summary, null, 2))
  console.log(`\nLevel stats → ${outJson}`)

  console.log('\n================ HARDWARE VOICE RESULT ================')
  for (const r of results) {
    console.log(`${r.id}  ${r.status}  ${r.title}`)
    console.log(`      ${r.evidence}`)
  }
  const fails = results.filter((r) => r.status === 'FAIL')
  console.log('-------------------------------------------------------')
  console.log(`Total ${results.length} | PASS ${results.length - fails.length} | FAIL ${fails.length}`)
  if (fails.length) console.log('FAILED: ' + fails.map((r) => r.id).join(', '))
  console.log(`Console errors: ${cdp.consoleErrors.length} | page exceptions: ${cdp.pageErrors.length}`)

  ws.close()
  return fails.length ? 1 : 0
}

const TERMINAL_RUN = new Set(['verified', 'rejected', 'clarify', 'conversational', 'failed'])

let exitCode = 2
const sinkBeforeForRestore = (() => {
  try { return readSinkState() } catch { return null }
})()
try {
  exitCode = await main()
} catch (err) {
  console.error('\nHARDWARE CHECK ERROR:', err?.stack ?? err)
  exitCode = 2
} finally {
  if (sinkBeforeForRestore) restoreSink(sinkBeforeForRestore)
  if (!KEEP_CHROME) {
    killChrome()
    try { rmSync(chromeArgs[1].slice('--user-data-dir='.length), { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
process.exit(exitCode)
