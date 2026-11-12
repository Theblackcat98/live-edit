#!/usr/bin/env node
// Fake llama.cpp family servers for end-to-end UI checks — no real models.
// Speaks the JSON the app parses: /v1/models (OpenAI data[]), /props (n_ctx),
// /v1/chat/completions (SSE deltas, tool_call deltas, finish_reason, timings),
// /v1/systemone (typed d1 answers + usage). Used by scripts/e2e/modes-e2e.mjs;
// also runnable on its own (`node scripts/e2e/fake-llama.mjs`) to click
// around the app by hand.
//
// Ports: 8080 text (1.7B), 8083 omni (starts "loading": HTTP 503 until
// GET /__ready), 8085 d1, 8086 audio. The user's command picks the route:
//   "append ..."      → an edit (d1 routes it, the worker writes add_text)
//   "maybe ..."       → d1 reads an edit at low confidence (0.30)
//   "d1down ..."      → d1 /v1/systemone answers HTTP 500
//   "disapprove ..."  → edit routed, the safety check disapproves (pending)
//   anything else     → conversation

import http from 'node:http'

const ALIAS = { 8080: 'lfm3-1.7b', 8083: 'lfm3-omni-2b', 8085: 'd1-omni-2b', 8086: 'lfm3-audio-2b' }
let omniLoading = true
export const FAKE_PORTS = [8080, 8083, 8085, 8086]

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...cors })
  res.end(JSON.stringify(body))
}

async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function lastUser(messages) {
  return [...(messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? ''
}

function commandFrom(text) {
  const m = /User command \(verbatim\): "([^"]*)"/.exec(text) || /command[^"]*"([^"]+)"/i.exec(text)
  return (m?.[1] ?? text).toLowerCase()
}

const timings = { prompt_n: 1500, prompt_ms: 210.4, predicted_n: 40, predicted_ms: 980.2, predicted_per_second: 40.8, cache_n: 1200 }

const XML =
  '<think>The user wants a line appended.</think>\n<tool_call>\n<function=add_text>\n' +
  '<parameter=file_path>notes/quarterly-review.md</parameter>\n<parameter=position>append</parameter>\n' +
  '<parameter=content>- Mock test line</parameter>\n</function>\n</tool_call>'

function sse(res, port, { text = '', toolCall = null }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...cors })
  const model = ALIAS[port]
  for (const piece of text.match(/.{1,12}/gs) ?? []) {
    res.write(`data: ${JSON.stringify({ model, choices: [{ delta: { content: piece } }] })}\n\n`)
  }
  if (toolCall) {
    res.write(
      `data: ${JSON.stringify({
        model,
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: toolCall }] } }],
      })}\n\n`,
    )
  }
  res.write(
    `data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }], timings })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

function handler(port) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'OPTIONS') return json(res, 204, {})
    if (url.pathname === '/__ready') {
      omniLoading = false
      return json(res, 200, { ok: true })
    }
    if (port === 8083 && omniLoading) return json(res, 503, { error: { message: 'Loading model', code: 503 } })
    if (url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: ALIAS[port], object: 'model' }] })
    }
    if (url.pathname === '/props') {
      return json(res, 200, { default_generation_settings: { n_ctx: port === 8083 ? 32000 : 64000 } })
    }
    if (url.pathname === '/v1/systemone') {
      const b = await body(req)
      const cmd = commandFrom(b.state ?? '')
      if (b.questions?.turn_intent) {
        if (cmd.includes('d1down')) return json(res, 500, { error: { message: 'mock d1 crash' } })
        const edit = cmd.includes('append') || cmd.includes('disapprove')
        const maybe = cmd.includes('maybe')
        return json(res, 200, {
          answers: {
            turn_intent: { type: 'choice', choice: edit || maybe ? 'insert' : 'conversational', probabilities: {} },
            intent_confidence: { type: 'noul', noul: maybe ? 0.3 : 0.92 },
          },
          usage: { input_tokens: 412, output_tokens: 0 },
        })
      }
      const bad = cmd.includes('disapprove')
      return json(res, 200, {
        answers: {
          does_call_match_directive: { type: 'noul', noul: bad ? 0.2 : 0.88 },
          destructive_safety: { type: 'choice', choice: 'safe', probabilities: { safe: 0.97, unintended_data_loss: 0.03 } },
          intent_clarity: { type: 'noul', noul: 0.9 },
          target_support: { type: 'choice', choice: 'supported', probabilities: { supported: 0.91, unsupported: 0.09 } },
          execution_confidence: { type: 'noul', noul: 0.85 },
        },
        usage: { input_tokens: 2650, output_tokens: 0 },
      })
    }
    if (url.pathname === '/v1/chat/completions') {
      const b = await body(req)
      const user = lastUser(b.messages)
      const cmd = user.toLowerCase()
      const wantsEdit = /append|disapprove/.test(cmd)
      if (port === 8080 && !b.stream) {
        // Packet decode (audio/omni modes): always the add_text call.
        return json(res, 200, {
          model: ALIAS[port],
          choices: [{ message: { content: XML }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2400, completion_tokens: 130 },
          timings,
        })
      }
      if (port === 8080) {
        // Worker-chat modes: the 1.7B chats or emits the call itself.
        return sse(res, port, { text: wantsEdit ? XML : 'Q4 is forecast at $1.6M in the note.' })
      }
      if (port === 8083 && b.tools && wantsEdit) {
        return sse(res, port, {
          toolCall: {
            name: 'delegate_edit',
            arguments: JSON.stringify({ task: 'insert', instruction: 'Append the line "- Mock test line" at the end of the note.' }),
          },
        })
      }
      const reply = wantsEdit || cmd.includes('maybe') || cmd.includes('d1down') ? 'Sure — updating that now.' : 'Hi! The note covers Q3 and Q4.'
      return sse(res, port, { text: reply })
    }
    json(res, 404, { error: { message: `no route ${url.pathname}` } })
  }
}

/** Start all four fake servers on 127.0.0.1; resolves once they listen. */
export async function startFakeLlama() {
  omniLoading = true
  const servers = await Promise.all(
    FAKE_PORTS.map(
      (port) =>
        new Promise((resolve, reject) => {
          const server = http.createServer(handler(port))
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => resolve(server))
        }),
    ),
  )
  return {
    close: () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startFakeLlama()
  console.log(`fake llama.cpp servers on 127.0.0.1:${FAKE_PORTS.join(', :')} (8083 loading until GET /__ready)`)
}
