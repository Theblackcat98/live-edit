#!/usr/bin/env node
// Model manager: the single source of truth for starting and stopping the
// four llama.cpp servers LiquidScribe can use (each run mode needs a subset —
// src/lib/modes.ts). `scripts/start-models.sh` and
// `scripts/stop-models.sh` are thin wrappers over this file; the `serve`
// mode is a loopback-only HTTP daemon the app uses to auto-start a run
// mode's models on switch (npm run models:manager).
//
//   text     LFM3-1.7B      :8080  worker XML tool calls
//   omni     LFM3-Omni-2B   :8083  chat + ASR (legacy front door)
//   d1-omni  d1-Omni-2B     :8085  routing / critic (zero-token)
//   audio    LFM3-Audio-2B  :8086  chat + ASR + TTS (default front door)
//
// Usage:
//   node scripts/model-manager.mjs status
//   node scripts/model-manager.mjs start [--all | name ...]   # waits for health
//   node scripts/model-manager.mjs stop  [--all | name ...]
//   node scripts/model-manager.mjs serve [--port 8199]
//
// Pid files and logs stay where the shell scripts kept them:
//   ~/Documents/Models/logs/lfm3/<name>.{pid,log}

import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const MODELS_ROOT = path.join(os.homedir(), 'Documents', 'Models')
const MODEL_DIR = path.join(MODELS_ROOT, 'lfm3')
const LOGDIR = path.join(MODELS_ROOT, 'logs', 'lfm3')
const DEFAULT_MANAGER_PORT = 8199
const HEALTH_TIMEOUT_MS = 2_000
const HEALTH_WAIT_MS = 120_000

// Member specs are ground truth: quant files, mmproj adapters, context
// windows, and per-member sampler flags. src/data/models.ts and the Runtime
// rail describe these to the UI; this table is what actually launches them.
const MODELS = [
  {
    name: 'text',
    port: 8080,
    gguf: 'LFM3-1.7B-Q4_K_M.gguf',
    alias: 'lfm3-1.7b',
    ctx: 128000,
    extra: ['--reasoning', 'on', '--reasoning-preserve', '--temp', '0.1', '--top-k', '50', '--repeat-penalty', '1.1'],
  },
  {
    name: 'omni',
    port: 8083,
    gguf: 'LFM3-Omni-2B-Q4_K_M.gguf',
    mmproj: 'mmproj-LFM3-Omni-2B-Q8_0.gguf',
    alias: 'lfm3-omni-2b',
    ctx: 32000,
    extra: ['--temp', '0'],
  },
  {
    name: 'd1-omni',
    port: 8085,
    gguf: 'd1-Omni-2B-Q8_0.gguf',
    mmproj: 'mmproj-d1-Omni-2B-Q8_0.gguf',
    alias: 'd1-omni-2b',
    ctx: 128000,
    extra: ['-b', '8192', '-ub', '8192'],
  },
  {
    name: 'audio',
    port: 8086,
    gguf: 'LFM3-Audio-2B-Q4_K_M.gguf',
    mmproj: 'mmproj-LFM3-Audio-2B-Q8_0.gguf',
    alias: 'lfm3-audio-2b',
    ctx: 128000,
    extra: ['--reasoning', 'on', '--reasoning-preserve', '--temp', '0.3'],
  },
]

for (const model of MODELS) {
  model.ggufPath = path.join(MODEL_DIR, model.gguf)
  if (model.mmproj) model.mmprojPath = path.join(MODEL_DIR, model.mmproj)
  model.pidfile = path.join(LOGDIR, `${model.name}.pid`)
  model.logfile = path.join(LOGDIR, `${model.name}.log`)
}

// --- backend resolution (same as lfm3.sh: ROCm build first, Vulkan fallback)

let cachedBin = null

function fileContains(file, needle) {
  // Chunked search: libllama.so can be hundreds of MB; never read it whole.
  const fd = fs.openSync(file, 'r')
  const chunkSize = 8 * 1024 * 1024
  const buffer = Buffer.alloc(chunkSize + needle.length - 1)
  try {
    let carry = 0
    for (;;) {
      const read = fs.readSync(fd, buffer, carry, chunkSize)
      if (read === 0) return false
      if (buffer.subarray(0, carry + read).includes(needle)) return true
      buffer.copy(buffer, 0, read, read + carry) // keep the tail for split matches
      carry = Math.min(needle.length - 1, carry + read)
    }
  } finally {
    fs.closeSync(fd)
  }
}

function pickBin() {
  if (cachedBin) return cachedBin
  for (const dir of [path.join(MODELS_ROOT, 'llama.cpp', 'build', 'bin'), path.join(MODELS_ROOT, 'llama.cpp', 'build-vulkan', 'bin')]) {
    const server = path.join(dir, 'llama-server')
    try {
      if (!fs.statSync(server).isFile() || !(fs.statSync(server).mode & 0o111)) continue
      const libs = fs.readdirSync(dir).filter((entry) => /^libllama\.so\./.test(entry))
      if (libs.some((lib) => fileContains(path.join(dir, lib), 'llama_model_lfm3'))) {
        cachedBin = dir
        return dir
      }
    } catch {
      // unreadable dir → try the next build
    }
  }
  console.error(`no llama.cpp build with lfm3 support found; run: cmake --build ~/Documents/Models/llama.cpp/build`)
  process.exit(1)
}

let cachedDevice = null

function pickDevice() {
  if (cachedDevice) return cachedDevice
  cachedDevice = 'ROCm0'
  try {
    const { stdout } = spawnSync(path.join(pickBin(), 'llama-server'), ['--list-devices'], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    for (const line of (stdout ?? '').split('\n')) {
      if (/Device/.test(line)) continue
      const match = /^([A-Za-z]+[0-9]+):/.exec(line)
      if (!match) continue
      if (/Ryzen|CPU|llvmpipe|Software/.test(line)) continue
      cachedDevice = match[1]
      break
    }
  } catch {
    // keep the ROCm0 default
  }
  return cachedDevice
}

// Family tuning from lfm3.sh: threads, batches, quantized KV, prompt cache.
function commonFlags() {
  return [
    '-t', '8', '-tb', '16',
    '--device', pickDevice(),
    '--gpu-layers', 'auto',
    '--fit', 'on',
    '-fa', 'on',
    '-b', '2048', '-ub', '512',
    '-np', '1',
    '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
    '--jinja',
    '--cache-prompt',
    '--metrics', '--slots',
    '--no-webui',
    '--host', '0.0.0.0',
  ]
}

// --- member state ------------------------------------------------------------

async function up(port) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function readPid(model) {
  try {
    const pid = Number.parseInt(fs.readFileSync(model.pidfile, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM' // alive but not ours to signal
  }
}

async function memberState(model) {
  const pid = readPid(model)
  const isUp = await up(model.port)
  return {
    name: model.name,
    port: model.port,
    up: isUp,
    starting: !isUp && pidAlive(pid),
    pid,
  }
}

// --- start / stop ------------------------------------------------------------

const startingNow = new Set() // guards double-spawn across concurrent daemon requests

async function startMember(model) {
  if (await up(model.port)) return { name: model.name, action: 'already-up' }
  const pid = readPid(model)
  if (pidAlive(pid)) return { name: model.name, action: 'starting', detail: `pid ${pid} still loading` }
  if (startingNow.has(model.name)) return { name: model.name, action: 'starting', detail: 'spawn in progress' }
  if (!fs.existsSync(model.ggufPath)) {
    return {
      name: model.name,
      action: 'error',
      detail: `missing ${model.ggufPath} - run ${MODELS_ROOT}/download-script/lfm3.sh`,
    }
  }
  if (model.mmprojPath && !fs.existsSync(model.mmprojPath)) {
    return {
      name: model.name,
      action: 'error',
      detail: `missing ${model.mmprojPath} - run ${MODELS_ROOT}/download-script/lfm3.sh`,
    }
  }
  const args = [
    '-m', model.ggufPath,
    ...(model.mmprojPath ? ['--mmproj', model.mmprojPath] : []),
    '--alias', model.alias,
    '-c', String(model.ctx),
    ...commonFlags(),
    ...model.extra,
    '--port', String(model.port),
  ]
  startingNow.add(model.name)
  try {
    const logFd = fs.openSync(model.logfile, 'a')
    const child = spawn(path.join(pickBin(), 'llama-server'), args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
    fs.writeFileSync(model.pidfile, String(child.pid))
    return { name: model.name, action: 'started', detail: `pid ${child.pid} on :${model.port}, log ${model.logfile}` }
  } catch (error) {
    return { name: model.name, action: 'error', detail: error?.message ?? String(error) }
  } finally {
    startingNow.delete(model.name)
  }
}

async function stopMember(model) {
  const pid = readPid(model)
  if (!pid) return { name: model.name, action: 'not-running', detail: 'no pid file' }
  try {
    process.kill(pid, 'SIGTERM')
    return { name: model.name, action: 'stopped', detail: `pid ${pid}` }
  } catch (error) {
    if (error?.code === 'ESRCH') return { name: model.name, action: 'not-running', detail: `pid ${pid} not running` }
    return { name: model.name, action: 'error', detail: error?.message ?? String(error) }
  } finally {
    fs.rmSync(model.pidfile, { force: true })
  }
}

async function waitForHealth(models, waitMs = HEALTH_WAIT_MS) {
  const deadline = Date.now() + waitMs
  const pending = new Set(models)
  for (;;) {
    for (const model of [...pending]) {
      if (await up(model.port)) pending.delete(model)
    }
    if (!pending.size || Date.now() >= deadline) return [...pending]
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

// --- CLI -----------------------------------------------------------------------

function resolveNames(args) {
  if (args.includes('--all')) return MODELS
  const names = args.filter((arg) => !arg.startsWith('--'))
  if (!names.length) return MODELS
  const members = names.map((name) => MODELS.find((model) => model.name === name))
  const missing = names.filter((_name, index) => !members[index])
  if (missing.length) {
    console.error(`unknown member(s): ${missing.join(', ')} — known: ${MODELS.map((m) => m.name).join(', ')}`)
    process.exit(2)
  }
  return members
}

async function cliStatus() {
  for (const model of MODELS) {
    const state = await memberState(model)
    const state_ = state.up ? 'up' : state.starting ? 'starting' : 'down'
    console.log(`${model.name.padEnd(8)} :${model.port}  ${state_}${state.pid ? `  (pid ${state.pid})` : ''}`)
  }
}

async function cliStart(args) {
  const members = resolveNames(args)
  for (const model of members) {
    const result = await startMember(model)
    console.log(`${result.name}: ${result.action}${result.detail ? ` — ${result.detail}` : ''}`)
  }
  const failed = await waitForHealth(members)
  for (const model of members) {
    console.log(failed.includes(model) ? `:${model.port} FAILED to come up - check ${LOGDIR}` : `:${model.port} up`)
  }
  process.exitCode = failed.length ? 1 : 0
}

async function cliStop(args) {
  const members = resolveNames(args)
  for (const model of members) {
    const result = await stopMember(model)
    console.log(`${result.name}: ${result.action}${result.detail ? ` — ${result.detail}` : ''}`)
  }
}

// --- HTTP daemon (loopback only — it spawns processes) -------------------------
//
// Binding to 127.0.0.1 keeps other machines out, but not other web pages: any
// site open in the user's browser can send requests to loopback. So the
// daemon (1) only grants CORS to pages served from loopback, (2) refuses a
// browser request whose Origin is anything else, and (3) requires
// `content-type: application/json` on mutations — which a cross-site page
// cannot send without a CORS preflight that (1) denies.

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

/** Requests with no Origin come from curl/scripts, not a web page. */
function originAllowed(origin) {
  return origin === undefined || LOOPBACK_ORIGIN.test(origin)
}

function jsonReply(response, status, payload, origin) {
  const body = JSON.stringify(payload)
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    vary: 'origin',
  }
  if (origin && LOOPBACK_ORIGIN.test(origin)) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
    headers['access-control-allow-headers'] = 'content-type'
  }
  response.writeHead(status, headers)
  response.end(status === 204 ? undefined : body)
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function membersFromBody(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.all === true) return MODELS
  const names = payload.names
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) return null
  const members = names.map((name) => MODELS.find((model) => model.name === name))
  return members.every(Boolean) ? members : null
}

function serve(port) {
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin
    const reply = (status, payload) => jsonReply(response, status, payload, origin)
    try {
      const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!originAllowed(origin)) {
        reply(403, { ok: false, error: `origin ${origin} may not control local models` })
        return
      }
      if (request.method === 'OPTIONS') {
        reply(204, {})
        return
      }
      if (pathname === '/status') {
        if (request.method !== 'GET') {
          reply(405, { ok: false, error: `${request.method} /status — use GET` })
          return
        }
        reply(200, { ok: true, members: await Promise.all(MODELS.map(memberState)) })
        return
      }
      if (pathname === '/start' || pathname === '/stop') {
        if (request.method !== 'POST') {
          reply(405, { ok: false, error: `${request.method} ${pathname} — use POST` })
          return
        }
        if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) {
          reply(415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          reply(400, { ok: false, error: `invalid JSON body: ${error?.message ?? 'unreadable'}` })
          return
        }
        const members = membersFromBody(body)
        if (!members) {
          reply(400, { ok: false, error: `body must be {names: [${MODELS.map((m) => m.name).join('|')}]} or {all: true}` })
          return
        }
        const action = pathname === '/start' ? startMember : stopMember
        const results = []
        for (const model of members) results.push(await action(model))
        // ok reflects the members, not just the request: a missing model file
        // is an error the caller must see, not a 200 it can ignore.
        reply(200, { ok: results.every((result) => result.action !== 'error'), results })
        return
      }
      reply(404, { ok: false, error: `no such route: ${request.method} ${pathname}` })
    } catch (error) {
      reply(500, { ok: false, error: error?.message ?? 'internal error' })
    }
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`model-manager listening on http://127.0.0.1:${port} (models outlive this daemon)`)
  })
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// --- entry -----------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2)
const portFlag = rest.indexOf('--port')
const port = portFlag !== -1 ? Number.parseInt(rest[portFlag + 1], 10) : DEFAULT_MANAGER_PORT

fs.mkdirSync(LOGDIR, { recursive: true })

switch (command) {
  case 'status':
    await cliStatus()
    break
  case 'start':
    await cliStart(rest)
    break
  case 'stop':
    await cliStop(rest)
    break
  case 'serve':
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`invalid --port: ${rest[portFlag + 1]}`)
      process.exit(2)
    }
    serve(port)
    break
  default:
    console.error('usage: model-manager.mjs status | start [--all|name...] | stop [--all|name...] | serve [--port N]')
    process.exit(command ? 2 : 0)
}
