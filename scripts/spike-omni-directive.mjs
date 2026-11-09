#!/usr/bin/env node
/**
 * E1 — Omni directive emission spike (Phase 0, docs/architecture-refactor.md §4,
 * design.md §5 + Q1).
 *
 * Question: can LFM3-Omni-2B on the local llama.cpp build (:8083, --jinja) emit
 * a schema-valid delegation — via (a) a NATIVE tool/function call, or (b) a
 * DELIMITED structured JSON block in the completion — reliably enough to be
 * the app's front door?
 *
 * Method: 20 scripted turns (design.md §13 battery in embryo, expanded) posted
 * to /v1/chat/completions in BOTH mechanisms, one rolling conversation per
 * mechanism, per-turn history maintained as the app would (follow-ups see
 * their antecedents). Sampling held fixed at the shipped client's values
 * (temperature 0.3, max_tokens 500) so E1 isolates the mechanism variable;
 * E2 (spike-omni-serving.mjs) tunes sampling on the winning mechanism.
 *
 * Protocol decisions (recorded so the numbers are interpretable):
 * - Directive schema = design.md §5 exactly: task/instruction required,
 *   frame_relevant required boolean, target/verbatim/constraints optional.
 * - REPAIR triggers on parse/schema failures ONLY (malformed JSON, wrong
 *   shape, missing required field, wrong function name, multiple calls /
 *   blocks). Semantic misses (wrong task, instruction lacking user-specified
 *   specifics, frame flag) are scored invalid WITHOUT repair — the app's
 *   repair path (design.md §5) appends schema errors, it does not coach
 *   semantics.
 * - WRONG-OUTCOME = the dangerous class: delegated a chat/clarify/action
 *   turn, or answered/chatted on an edit/delegate/action turn. Never valid.
 * - Undo: per design.md §4.7 undo/redo is a harness action, never a worker
 *   task. Both mechanisms are told to signal it with the exact line
 *   "ACTION undo" / "ACTION redo". A delegation on the undo turn is scored
 *   wrong-outcome (it would route an undo through the worker).
 * - Validity for delegate turns = schema-valid AND task matches the expected
 *   task AND the instruction carries the user-specified specifics
 *   (mustMention regexes below — the §5 "brief, not the content" bar).
 * - History: after a valid delegation the assistant turn is recorded as a
 *   short canned confirmation ("Done — <task> applied: <instruction>.") —
 *   the spike has no worker/execution, so there is nothing else honest to
 *   record; the note in context stays frozen at the seed note (documented
 *   limitation). Chat/clarify turns record the model's own reply verbatim.
 * - The frame (synthetic-slide equivalent) is a PNG generated in-script from
 *   the same content as src/lib/frame.ts's slide (title, revenue table,
 *   "LTV / CAC = 3.4x" north-star card, trajectory bars, finance sticky) and
 *   attached as an image_url on the two frame-relevant turns, exactly the
 *   way bridge.ts attaches frames.
 *
 * Zero npm dependencies: Node 22 built-ins only. Be gentle: sequential
 * requests, 250 ms delay, 120 s per-request timeout.
 *
 * Output: docs/spikes/E1-omni-directive.json (raw results; every number in
 * the companion .md comes from it).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

// ---------------------------------------------------------------- config ---

export const BASE_URL = 'http://127.0.0.1:8083'
export const MODEL = 'lfm3-omni-2b'
const TEMPERATURE = 0.3 // shipped client value (E1 isolates mechanism, E2 tunes this)
export const MAX_TOKENS = 500 // shipped client value
const DELAY_MS = 250
const REQUEST_TIMEOUT_MS = 120_000
const REPAIR_ATTEMPTS = 1 // single retry with the error appended (design.md §5)

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(SCRIPT_DIR, '..', 'docs', 'spikes', 'E1-omni-directive.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------- seed note ---
// Verbatim from src/data/note.ts INITIAL_NOTE @ ece8919 (1,312 chars, 43 lines).
export const SEED_NOTE = `# Q3 Business Review

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

// ------------------------------------------------- synthetic frame (PNG) ---
// Hand-rendered PNG (no deps): same content as the app's synthetic slide in
// src/lib/frame.ts — Q3 operating review: revenue table, LTV / CAC = 3.4x
// north-star card, trajectory bars, finance sticky. 5x7 bitmap font.

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  $: ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '>': ['10000', '01000', '00100', '00010', '00100', '01000', '10000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
}

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Render the synthetic-slide equivalent and return it as a data URL. */
export function buildFrameDataUrl() {
  const W = 768
  const H = 432
  const px = new Uint8Array(W * H * 3)
  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
  const BG = hex('#f2f4f0'), CARD = hex('#fbfbf9'), BORDER = hex('#d7dde6')
  const INK = hex('#1c2430'), MUTED = hex('#5a6f8f'), GREEN = hex('#2f7a56')
  const AMBER = hex('#b0761e'), BLUE = hex('#5a6f8f'), STICKY = hex('#f5df8e')
  const STICKY_BORDER = hex('#e3c96a'), STICKY_INK = hex('#4a4020'), BAR_GREEN = hex('#3f8f6f')
  const BAR_AMBER = hex('#e0a63c'), BAR_BLUE = hex('#5a6f8f')

  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 3
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]
  }
  const fillRect = (x, y, w, h, c) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c)
  }
  const outlineRect = (x, y, w, h, c) => {
    fillRect(x, y, w, 1, c); fillRect(x, y + h - 1, w, 1, c)
    fillRect(x, y, 1, h, c); fillRect(x + w - 1, y, 1, h, c)
  }
  const text = (x, y, s, scale, c) => {
    let cx = x
    for (const ch of s.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT[ch.toLowerCase()] ?? FONT[' ']
      for (let r = 0; r < 7; r++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[r][col] === '1') fillRect(cx + col * scale, y + r * scale, scale, scale, c)
        }
      }
      cx += 6 * scale
    }
  }

  fillRect(0, 0, W, H, BG)
  fillRect(16, 12, W - 32, H - 24, CARD)
  outlineRect(16, 12, W - 32, H - 24, BORDER)

  fillRect(48, 32, 26, 5, BAR_GREEN)
  text(84, 28, 'Q3 OPERATING REVIEW', 2, MUTED)
  text(560, 28, 'CONFIDENTIAL', 1, MUTED)
  text(48, 52, 'REVENUE & OPERATING EFFICIENCY', 3, INK)
  text(48, 86, 'OPERATING REVIEW - 14 NOVEMBER - FINANCE', 2, MUTED)

  // left: revenue table
  text(48, 120, 'REVENUE BY QUARTER', 2, MUTED)
  const rows = [
    ['Q1', '$0.92M', 'CLOSED', INK],
    ['Q2', '$1.08M', 'CLOSED', INK],
    ['Q3', '$1.20M', 'PENDING', AMBER],
    ['Q4', '$1.35M', 'FORECAST', BLUE],
  ]
  let ty = 142
  for (const [q, v, s, c] of rows) {
    text(48, ty, q, 2, INK)
    text(108, ty, v, 2, INK)
    text(228, ty, s, 2, c)
    ty += 24
  }
  fillRect(48, ty + 2, 330, 1, BORDER)

  // left-bottom: finance sticky
  fillRect(48, 268, 230, 108, STICKY)
  outlineRect(48, 268, 230, 108, STICKY_BORDER)
  text(64, 282, 'FINANCE NOTE', 2, MUTED)
  text(64, 310, 'FINAL INVOICE', 2, STICKY_INK)
  text(64, 336, 'RECON STILL', 2, STICKY_INK)
  text(64, 362, 'PENDING.', 2, STICKY_INK)

  // right: north-star formula card
  text(430, 120, 'NORTH STAR', 2, MUTED)
  fillRect(430, 132, 300, 100, CARD)
  outlineRect(430, 132, 300, 100, BORDER)
  text(446, 150, 'LTV / CAC = 3.4x', 3, INK)
  text(446, 196, 'TARGET >= 3.0x', 2, GREEN)

  // right: trajectory bars
  text(430, 250, 'TRAJECTORY', 2, MUTED)
  const bars = [
    { label: 'Q1', value: '$0.92M', h: 62, c: BAR_GREEN },
    { label: 'Q2', value: '$1.08M', h: 76, c: BAR_GREEN },
    { label: 'Q3', value: '$1.20M', h: 90, c: BAR_AMBER },
    { label: 'Q4', value: '$1.35M', h: 104, c: BAR_BLUE },
  ]
  const baseY = 386
  bars.forEach((b, i) => {
    const bx = 438 + i * 72
    fillRect(bx, baseY - b.h, 48, b.h, b.c)
    text(bx, baseY + 6, b.label, 1, MUTED)
    text(bx - 10, baseY - b.h - 14, b.value, 1, MUTED)
  })
  fillRect(48, 404, W - 96, 1, BORDER)
  text(48, 410, 'LFM - OPERATING REVIEW', 1, MUTED)
  text(600, 410, 'Q3 - 2026', 1, MUTED)

  return 'data:image/png;base64,' + encodePng(W, H, px).toString('base64')
}

// ------------------------------------------------------------------ turns ---
/**
 * The 20 scripted turns — design.md §13 battery in embryo, expanded.
 * expect: answer | clarify | delegate | action.
 * For delegate turns: task = expected §5 task, mustMention = regexes the
 * instruction (+verbatim+constraints) must match (the "brief carries
 * everything the user specified" bar), extra = recorded-but-not-required.
 * frame: attach the generated slide image to this user turn.
 */
export const TURNS = [
  { id: 'T01', text: 'hey', expect: 'answer' },
  { id: 'T02', text: 'what can you see?', expect: 'answer', frame: true },
  { id: 'T03', text: 'remember that my favorite color is teal', expect: 'answer' },
  { id: 'T04', text: 'what is my favorite color?', expect: 'answer' },
  { id: 'T05', text: 'update the Q3 revenue row to $1.45M Final', expect: 'delegate', task: 'edit', mustMention: [/\bq3\b/i, /\$1\.45\s*m/i], extra: [/final/i] },
  { id: 'T06', text: 'do the same for Q4 to $1.5M', expect: 'delegate', task: 'edit', mustMention: [/\bq4\b/i, /\$1\.5\s*m/i] },
  { id: 'T07', text: 'summarize the note so far in two sentences', expect: 'answer' },
  { id: 'T08', text: 'remove the bullet about Redis', expect: 'delegate', task: 'remove', mustMention: [/redis/i] },
  { id: 'T09', text: 'undo that', expect: 'action', action: 'undo' },
  { id: 'T10', text: 'change the number', expect: 'clarify' },
  { id: 'T11', text: 'add a line under Security: rotate keys monthly', expect: 'delegate', task: 'insert', mustMention: [/security/i, /rotate\s+keys\s+monthly/i] },
  { id: 'T12', text: 'pull the LTV/CAC formula from the slide into Revenue', expect: 'delegate', task: 'extract', mustMention: [/ltv|formula/i, /revenue/i], frame: true, frameRequired: true },
  { id: 'T13', text: 'write a README template document to begin', expect: 'delegate', task: 'create', mustMention: [/readme/i, /template|section|overview|getting started|standard/i] },
  { id: 'T14', text: 'rename the title to Q3 Review Final', expect: 'delegate', task: 'edit', mustMention: [/q3\s+review\s+final/i] },
  { id: 'T15', text: 'make it better', expect: 'clarify' },
  { id: 'T16', text: 'hey, could you add a bullet under Follow-ups saying send the deck to finance', expect: 'delegate', task: 'insert', mustMention: [/follow-?\s*ups/i, /send\s+the\s+deck\s+to\s+finance/i] },
  { id: 'T17', text: 'um, please delete the bullet about API keys', expect: 'delegate', task: 'remove', mustMention: [/api\s*keys/i] },
  { id: 'T18', text: 'create a changelog template in this document', expect: 'delegate', task: 'create', mustMention: [/changelog/i, /template|version|section/i] },
  { id: 'T19', text: 'what happens if I remove the Q3 row?', expect: 'answer' },
  { id: 'T20', text: 'delete the Q1 row from the revenue table', expect: 'delegate', task: 'remove', mustMention: [/\bq1\b/i, /row|table/i] },
]

/** Destructive turns (expected task edit/remove) — the zero-wrong-outcome bar. */
export const DESTRUCTIVE_IDS = TURNS.filter((t) => t.expect === 'delegate' && (t.task === 'edit' || t.task === 'remove')).map((t) => t.id)

// ------------------------------------------------------------- prompting ---

const FUNCTION_NAME = 'delegate_edit'

export const DELEGATE_TOOL = {
  type: 'function',
  function: {
    name: FUNCTION_NAME,
    description: 'Delegate a note-editing task to the worker model as a typed directive.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', enum: ['create', 'insert', 'edit', 'remove', 'extract'], description: 'Kind of note task.' },
        instruction: { type: 'string', description: 'Brief for the worker: everything the user specified about the content, references resolved from the conversation. A brief, not the content itself.' },
        target: { type: 'object', properties: { description: { type: 'string' }, heading: { type: ['string', 'null'] } }, description: 'Optional: where in the note the change belongs.' },
        verbatim: { type: ['string', 'null'], description: 'Exact user-dictated text, only when the user dictated exact words; otherwise null.' },
        constraints: { type: ['array', 'null'], items: { type: 'string' }, description: 'Optional requirements, e.g. markdown format or keep-other-content.' },
        frame_relevant: { type: 'boolean', description: 'True only when the task depends on the attached visual frame.' },
      },
      required: ['task', 'instruction', 'frame_relevant'],
    },
  },
}

const BLOCK_OPEN = '<<<DIRECTIVE'
const BLOCK_CLOSE = '>>>'

function systemPrompt(mechanism, noteText) {
  const core = `You are Omni, the interface model of a note-editing app. The user talks to you; you can see the current note below and, when an image is attached to a user turn, the visual frame (what the user calls "the slide", "the chart" or "the screen").

Current note (markdown):
<note>
${noteText}
</note>

On every user turn, do exactly one of three things:

1. ANSWER - reply in plain conversational text: greetings, questions, chat, statements about the user, hypotheticals — anything that does not require changing the note. You never author note content yourself, not even as a draft in chat: content in the note is written only by a worker model, and the only way to reach it is the delegation mechanism below.

2. DELEGATE - when the user wants content added, changed, created, removed, or extracted in the note, emit ONE directive (mechanism below). Even when the user says "write" or "create", the mechanism is always delegation — you never produce the content yourself. The directive is a brief for a worker model that never sees this conversation:
   - task: create | insert | edit | remove | extract
   - instruction: pack in EVERYTHING the user specified about the content (sections named, values given, exact wording dictated, tone asked for) and resolve references like "the same for Q4" or "that bullet" from the conversation. A brief, not the content itself.
   - target: optional object {"description": where the change belongs, "heading": section heading or null}
   - verbatim: exact dictated text only when the user dictated exact words to appear in the note, otherwise null
   - constraints: optional array of requirements, e.g. ["markdown", "keep the existing content intact"]
   - frame_relevant: true only when the task depends on the attached visual frame

3. ACTION - if the user asks to undo or redo the last change, reply with exactly "ACTION undo" or "ACTION redo" and nothing else. These are harness actions: never delegate them as a task, never claim you performed them yourself.

If the user's request would change the note but is too ambiguous to form a responsible directive, ANSWER with a single short clarifying question instead of delegating a guess.`

  const native = `DELEGATE mechanism: call the function ${FUNCTION_NAME} with the directive as its arguments (exactly one call, nothing else in that turn). Do not call it when the turn only needs an answer.`
  const delimited = `DELEGATE mechanism: emit exactly one directive block in your reply, delimited exactly like this, containing valid JSON only (no markdown fences, no comments):
${BLOCK_OPEN}
{"task": "edit", "instruction": "...", "target": {"description": "...", "heading": null}, "verbatim": null, "constraints": ["..."], "frame_relevant": false}
${BLOCK_CLOSE}
Apart from that block, add at most one short sentence and nothing else.`

  return mechanism === 'native-tools'
    ? `${core}\n\n${native}`
    : `${core}\n\n${delimited}`
}

export function applyNoteCap(noteText, capChars) {
  if (capChars == null || noteText.length <= capChars) {
    return { text: noteText, truncated: false, shownChars: noteText.length }
  }
  const text = noteText.slice(0, capChars) + '\n[...note truncated at ' + capChars + ' chars...]'
  return { text, truncated: true, shownChars: capChars }
}

// ------------------------------------------------------------ validation ---

const TASKS = new Set(['create', 'insert', 'edit', 'remove', 'extract'])

/** Schema validation per design.md §5. Returns {ok, errors, directive}. */
export function validateDirective(value) {
  const errors = []
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['directive is not a JSON object'], directive: null }
  }
  const { task, instruction, target, verbatim, constraints, frame_relevant } = value
  if (typeof task !== 'string' || !TASKS.has(task)) errors.push(`task must be one of create|insert|edit|remove|extract (got ${JSON.stringify(task)})`)
  if (typeof instruction !== 'string' || instruction.trim().length < 8) errors.push('instruction must be a non-empty string (min 8 chars)')
  if (target != null && (typeof target !== 'object' || Array.isArray(target))) errors.push('target must be an object or null')
  if (verbatim != null && typeof verbatim !== 'string') errors.push('verbatim must be a string or null')
  if (constraints != null && (!Array.isArray(constraints) || constraints.some((c) => typeof c !== 'string'))) errors.push('constraints must be an array of strings or null')
  if (typeof frame_relevant !== 'boolean') errors.push('frame_relevant is required and must be a boolean')
  return { ok: errors.length === 0, errors, directive: value }
}

const ACTION_RE = /(?:^|\n)\s*ACTION[ :]+(undo|redo)\b/i

/** Pipeline vocabulary that must not appear in visible replies (design §13.6). */
const PIPELINE_VOCAB_RE = /<<<DIRECTIVE|<\/?tool_call|<function=|delegate_edit|\bdirective\b|\bworker model\b/i

function semanticCheck(turn, directive) {
  const problems = []
  if (turn.task && directive.task !== turn.task) {
    problems.push(`task mismatch: got "${directive.task}", expected "${turn.task}"`)
  }
  const corpus = [directive.instruction, directive.verbatim, Array.isArray(directive.constraints) ? directive.constraints.join(' ') : '']
    .filter(Boolean).join(' \n ')
  const missing = (turn.mustMention ?? []).filter((re) => !re.test(corpus)).map((re) => `${re}`)
  if (missing.length) problems.push(`instruction does not carry user-specified specifics (failed: ${missing.join(', ')})`)
  if (turn.frameRequired && directive.frame_relevant !== true) {
    problems.push('frame_relevant must be true for this frame-dependent task')
  }
  const extrasMet = (turn.extra ?? []).every((re) => re.test(corpus))
  return { problems, missing, extrasMet, frameRelevant: directive.frame_relevant }
}

// --------------------------------------------------------------- request ---

export async function chatOnce({ messages, tools, temperature, maxTokens }) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const body = { model: MODEL, messages, temperature, max_tokens: maxTokens, stream: false }
    if (tools) { body.tools = tools; body.tool_choice = 'auto' }
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const ms = Date.now() - started
    const text = await response.text()
    let payload = null
    try { payload = text ? JSON.parse(text) : null } catch { payload = null }
    if (!response.ok) {
      return { ok: false, ms, httpStatus: response.status, error: `HTTP ${response.status}: ${text.slice(0, 300)}` }
    }
    const choice = payload?.choices?.[0] ?? {}
    const message = choice.message ?? {}
    return {
      ok: true,
      ms,
      httpStatus: response.status,
      finishReason: choice.finish_reason ?? null,
      content: typeof message.content === 'string' ? message.content : '',
      reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      usage: payload?.usage ?? null,
      raw: payload,
    }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

// ------------------------------------------------------------- mechanisms ---

/** Extract + parse the directive block from a completion (mechanism b). */
export function parseBlock(content) {
  const matches = [...content.matchAll(/<<<DIRECTIVE([\s\S]*?)>>>/g)]
  if (matches.length === 0) return { found: false, blocks: 0 }
  if (matches.length > 1) return { found: true, blocks: matches.length, parseError: 'multiple directive blocks (exactly one allowed)' }
  let inner = matches[0][1].trim()
  inner = inner.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    return { found: true, blocks: 1, value: JSON.parse(inner), raw: inner }
  } catch (e) {
    return { found: true, blocks: 1, parseError: `block is not valid JSON: ${e.message}`, raw: inner.slice(0, 400) }
  }
}

function extractDirectiveCandidate(mechanism, result) {
  if (mechanism === 'native-tools') {
    if (result.toolCalls.length === 0) return { attempted: false }
    if (result.toolCalls.length > 1) return { attempted: true, parseError: `multiple tool calls (${result.toolCalls.length}); exactly one delegate_edit call allowed`, toolCall: result.toolCalls[0] }
    const call = result.toolCalls[0]
    const name = call?.function?.name
    if (name !== FUNCTION_NAME) return { attempted: true, parseError: `unknown function "${name}" (only ${FUNCTION_NAME} exists)`, toolCall: call }
    const args = call?.function?.arguments
    try {
      const value = typeof args === 'string' ? JSON.parse(args) : args
      return { attempted: true, value, toolCall: call }
    } catch (e) {
      return { attempted: true, parseError: `function arguments are not valid JSON: ${e.message}`, toolCall: call }
    }
  }
  const parsed = parseBlock(result.content)
  if (!parsed.found) {
    // The model may try to delegate via raw XML in text — detect for honesty.
    const xmlAttempt = /<tool_call|<function=/.test(result.content)
    return { attempted: xmlAttempt, parseError: xmlAttempt ? 'attempted delegation as raw XML in text instead of the delimited block' : undefined }
  }
  return { attempted: true, ...parsed }
}

// ------------------------------------------------------------ turn runner ---

/**
 * Run one conversation of all 20 turns under one mechanism/config.
 * Returns per-turn records with attempts, classification, and history text.
 */
export async function runConversation({ mechanism, temperature, maxTokens, noteText, turns = TURNS, delayMs = DELAY_MS, onTurn }) {
  const frameDataUrl = buildFrameDataUrl()
  const system = systemPrompt(mechanism, noteText)
  const history = []
  const records = []
  let lastResult = null

  for (const turn of turns) {
    const userContent = turn.frame
      ? [{ type: 'text', text: turn.text }, { type: 'image_url', image_url: { url: frameDataUrl } }]
      : turn.text
    const baseMessages = [{ role: 'system', content: system }, ...history, { role: 'user', content: userContent }]

    const record = {
      turnId: turn.id, text: turn.text, expect: turn.expect,
      expectedTask: turn.task ?? null, attempts: [],
    }

    let messages = baseMessages
    let finalClass = null // valid_first_try | valid_after_repair | invalid | wrong_outcome | error
    let reason = null
    let semantic = null
    let directiveOut = null
    let replyText = null
    let actionOut = null
    let repaired = false

    for (let attemptNo = 0; attemptNo <= REPAIR_ATTEMPTS; attemptNo++) {
      const result = await chatOnce({
        messages,
        tools: mechanism === 'native-tools' ? [DELEGATE_TOOL] : undefined,
        temperature, maxTokens,
      })
      lastResult = result
      await sleep(delayMs)

      const attempt = {
        attempt: attemptNo + 1,
        ms: result.ms,
        ok: result.ok,
        httpStatus: result.httpStatus ?? null,
        finishReason: result.finishReason ?? null,
        usage: result.usage ?? null,
      }
      if (!result.ok) {
        attempt.error = result.error
        record.attempts.push(attempt)
        finalClass = 'error'; reason = result.error
        break
      }
      attempt.content = result.content
      if (result.reasoningContent) attempt.reasoningContent = result.reasoningContent
      if (result.toolCalls.length) attempt.toolCalls = result.toolCalls.map((c) => ({ name: c?.function?.name, arguments: c?.function?.arguments }))

      const cand = extractDirectiveCandidate(mechanism, result)

      if (cand.attempted) {
        // A delegation attempt exists.
        if (turn.expect !== 'delegate') {
          attempt.classification = 'delegation-on-nondelegate-turn'
          record.attempts.push(attempt)
          finalClass = 'wrong_outcome'
          reason = `delegated a turn that expected "${turn.expect}"`
          directiveOut = cand.value ?? cand.raw ?? null
          break
        }
        let validation = { ok: false, errors: [cand.parseError ?? 'unparsed directive'], directive: null }
        if (!cand.parseError && cand.value != null) validation = validateDirective(cand.value)
        attempt.directive = validation.directive
        attempt.schemaErrors = validation.ok ? [] : validation.errors
        if (!validation.ok) {
          record.attempts.push(attempt)
          if (attemptNo < REPAIR_ATTEMPTS) {
            // one repair: append the failed attempt + the schema error
            if (mechanism === 'native-tools') {
              messages = [...messages,
                { role: 'assistant', content: '', tool_calls: result.toolCalls },
                { role: 'tool', tool_call_id: result.toolCalls[0]?.id ?? 'repair', content: `Schema error: ${validation.errors.join('; ')}. Emit exactly one corrected ${FUNCTION_NAME} call now.` }]
            } else {
              messages = [...messages,
                { role: 'assistant', content: result.content },
                { role: 'user', content: `Your directive block was invalid: ${validation.errors.join('; ')}. Reply again with exactly one corrected ${BLOCK_OPEN} ... ${BLOCK_CLOSE} block containing valid JSON.` }]
            }
            repaired = true
            continue
          }
          finalClass = 'invalid'; reason = `schema invalid after repair: ${validation.errors.join('; ')}`
          break
        }
        // Schema-valid: semantic adequacy (no repair for semantics — recorded).
        semantic = semanticCheck(turn, validation.directive)
        attempt.semantic = semantic
        record.attempts.push(attempt)
        directiveOut = validation.directive
        if (semantic.problems.length === 0) {
          finalClass = repaired ? 'valid_after_repair' : 'valid_first_try'
        } else {
          finalClass = 'invalid'; reason = `semantically inadequate (no repair for semantics): ${semantic.problems.join('; ')}`
        }
        break
      }

      // No delegation attempt: plain text (or empty).
      const text = (result.content ?? '').trim()
      attempt.isQuestion = /\?/.test(text)
      attempt.actionLine = (text.match(ACTION_RE) ?? [null])[1]?.toLowerCase() ?? null
      const hygieneHits = text ? (text.match(PIPELINE_VOCAB_RE) ?? []) : []
      attempt.hygieneHits = [...new Set(hygieneHits.map(String))]
      record.attempts.push(attempt)
      replyText = text

      if (attempt.actionLine) {
        if (turn.expect === 'action' && attempt.actionLine === turn.action) {
          finalClass = repaired ? 'valid_after_repair' : 'valid_first_try'
          actionOut = attempt.actionLine
        } else {
          finalClass = 'wrong_outcome'
          reason = turn.expect === 'action'
            ? `action turn signaled "${attempt.actionLine}" where "${turn.action}" was expected`
            : `claimed a harness ACTION on a turn that expected "${turn.expect}"`
          actionOut = attempt.actionLine
        }
        break
      }
      if (turn.expect === 'action') {
        finalClass = 'wrong_outcome'
        reason = `undo/redo turn answered in chat instead of the ACTION signal: "${text.slice(0, 120)}"`
        break
      }
      if (turn.expect === 'delegate') {
        if (!text) {
          finalClass = 'invalid'; reason = 'empty completion on an edit turn (no directive emitted)'
        } else {
          finalClass = 'wrong_outcome'
          reason = `answered/chatted on an edit turn (no directive emitted): "${text.slice(0, 120)}"`
        }
        break
      }
      if (!text) {
        finalClass = 'invalid'; reason = 'empty completion'
        break
      }
      if (turn.expect === 'clarify') {
        if (attempt.isQuestion) {
          finalClass = repaired ? 'valid_after_repair' : 'valid_first_try'
        } else {
          finalClass = 'invalid'; reason = `clarify turn answered without a question: "${text.slice(0, 120)}"`
        }
        break
      }
      // expect === 'answer'
      if (attempt.hygieneHits.length) {
        finalClass = 'invalid'; reason = `chat reply contains pipeline vocabulary: ${attempt.hygieneHits.join(', ')}`
        break
      }
      finalClass = repaired ? 'valid_after_repair' : 'valid_first_try'
      break
    }

    record.finalClass = finalClass
    record.reason = reason
    record.valid = finalClass === 'valid_first_try' || finalClass === 'valid_after_repair'
    record.wrongOutcome = finalClass === 'wrong_outcome'
    if (directiveOut) record.directive = directiveOut

    // ---- rolling history: only what the model itself produced, plus tool
    // results. Harness-invented assistant prose (canned confirmations or
    // failure lines) is NOT appended — the first two E1 runs showed the 2B
    // few-shot-copies any repeated harness string verbatim (both a placeholder
    // and rotated "natural" failure lines), which contaminated the runs.
    // - valid native delegation: assistant tool_call + tool "Executed" result
    // - failed native delegation (schema or semantics): assistant tool_call +
    //   tool "Execution failed" result (the honest standard-tool-flow record)
    // - delimited turns with a block: the raw completion (blocks stay — the
    //   mechanism has no separate result channel; this is what the app would
    //   resend)
    // - chat/clarify/wrong-outcome replies: the model's own text verbatim
    // - turns with no model output (request error, empty completion): no
    //   assistant message at all (the template accepts consecutive user turns)
    history.push({ role: 'user', content: turn.text })
    const okFinal = finalClass === 'valid_first_try' || finalClass === 'valid_after_repair'
    const attemptsWithCalls = record.attempts.filter((a) => a.ok && a.toolCalls?.length)
    const lastContentAttempt = [...record.attempts].reverse().find((a) => a.ok && typeof a.content === 'string' && a.content.trim())
    if (okFinal && turn.expect === 'delegate' && mechanism === 'native-tools') {
      history.push({ role: 'assistant', content: '', tool_calls: lastResult.toolCalls })
      history.push({ role: 'tool', tool_call_id: lastResult.toolCalls?.[0]?.id ?? `del-${turn.id}`, content: `Executed: the worker applied the ${directiveOut.task}.` })
      record.history_appended = `assistant tool_call + tool result (executed ${directiveOut.task})`
    } else if (!okFinal && attemptsWithCalls.length) {
      const call = attemptsWithCalls.at(-1)
      history.push({ role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: call.toolCalls[0].name, arguments: call.toolCalls[0].arguments }, id: call.toolCalls[0].id ?? `del-${turn.id}` }] })
      history.push({ role: 'tool', tool_call_id: call.toolCalls[0].id ?? `del-${turn.id}`, content: 'Execution failed: the edit could not be applied.' })
      record.history_appended = 'assistant tool_call + tool result (execution failed)'
    } else if (lastContentAttempt) {
      history.push({ role: 'assistant', content: lastContentAttempt.content })
      record.history_appended = 'assistant: model output verbatim'
    } else {
      record.history_appended = 'no assistant message (no model output this turn)'
    }

    records.push(record)
    onTurn?.(record)
  }
  return records
}

export function summarize(records) {
  const by = (cls) => records.filter((r) => r.finalClass === cls).length
  const destructive = records.filter((r) => DESTRUCTIVE_IDS.includes(r.turnId))
  const wrongOnDestructive = destructive.filter((r) => r.wrongOutcome).map((r) => r.turnId)
  const validTotal = by('valid_first_try') + by('valid_after_repair')
  const allMs = records.flatMap((r) => r.attempts.map((a) => a.ms))
  const sortedMs = [...allMs].sort((a, b) => a - b)
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
  return {
    turns: records.length,
    valid_first_try: by('valid_first_try'),
    valid_after_repair: by('valid_after_repair'),
    valid_total: validTotal,
    invalid: by('invalid'),
    wrong_outcome: by('wrong_outcome'),
    error: by('error'),
    wrong_outcome_ids: records.filter((r) => r.wrongOutcome).map((r) => r.turnId),
    invalid_ids: records.filter((r) => r.finalClass === 'invalid').map((r) => r.turnId),
    error_ids: records.filter((r) => r.finalClass === 'error').map((r) => r.turnId),
    destructive_wrong_outcome_count: wrongOnDestructive.length,
    destructive_wrong_outcome_ids: wrongOnDestructive,
    pass_bar: {
      rule: '>=18/20 valid after <=1 repair AND zero wrong-outcome on remove/edit turns',
      valid_ok: validTotal >= 18,
      destructive_ok: wrongOnDestructive.length === 0,
      met: validTotal >= 18 && wrongOnDestructive.length === 0,
    },
    latency: {
      requests: allMs.length,
      mean_ms: mean(allMs),
      median_ms: sortedMs.length ? sortedMs[Math.floor(sortedMs.length / 2)] : 0,
      p95_ms: sortedMs.length ? sortedMs[Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * 0.95))] : 0,
    },
  }
}

// ------------------------------------------------------------------ main ---

async function main() {
  console.log(`E1 — Omni directive emission spike`)
  console.log(`server ${BASE_URL} model ${MODEL} temp ${TEMPERATURE} max_tokens ${MAX_TOKENS}`)
  const health = await fetch(`${BASE_URL}/health`).catch(() => null)
  if (!health?.ok) {
    console.error('server :8083 is down — refusing to run (no fabricated numbers)')
    process.exitCode = 2
    return
  }

  const mechanisms = ['native-tools', 'delimited-block']
  const results = {}
  for (const mechanism of mechanisms) {
    console.log(`\n== mechanism: ${mechanism}`)
    const t0 = Date.now()
    const records = await runConversation({
      mechanism,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
      noteText: SEED_NOTE,
      onTurn: (r) => console.log(`  ${r.turnId} [${r.finalClass}]${r.reason ? ' — ' + r.reason.slice(0, 90) : ''}`),
    })
    const summary = summarize(records)
    summary.wall_ms = Date.now() - t0
    results[mechanism] = { summary, turns: records }
    console.log(`  summary: ${summary.valid_first_try} first-try + ${summary.valid_after_repair} repaired = ${summary.valid_total}/20 valid | invalid ${summary.invalid} | wrong-outcome ${summary.wrong_outcome} (${summary.wrong_outcome_ids.join(',') || '-'}) | errors ${summary.error}`)
    console.log(`  destructive wrong-outcome: ${summary.destructive_wrong_outcome_count} | pass bar met: ${summary.pass_bar.met}`)
  }

  const payload = {
    spike: 'E1 — Omni directive emission',
    generated_at: new Date().toISOString(),
    server: { base_url: BASE_URL, model: MODEL, health: 'ok' },
    sampling: { temperature: TEMPERATURE, max_tokens: MAX_TOKENS, delay_ms: DELAY_MS, request_timeout_ms: REQUEST_TIMEOUT_MS, seed: 'server default (not pinned)' },
    directive_schema: 'design.md §5: {task: create|insert|edit|remove|extract, instruction, target?, verbatim?, constraints?, frame_relevant} — task/instruction/frame_relevant required',
    scoring_rules: {
      valid: 'expected outcome via the mechanism; for delegate turns: schema-valid AND task matches AND instruction carries the user-specified specifics (mustMention)',
      repair: 'triggered only by parse/schema failures (one retry with the error appended); semantic misses are scored invalid without repair',
      wrong_outcome: 'delegated a chat/clarify/action turn, or answered/chatted/clarified on an edit or action turn, or claimed an ACTION on a non-action turn',
      error: 'HTTP/network/timeout failure — recorded as failure, never valid',
    },
    history_policy: 'rolling API-level history contains ONLY model-authored output plus tool results (no harness-invented assistant prose — runs 1 and 2 of this spike showed the 2B few-shot-copies repeated harness strings, which invalidated those runs; fixed): valid native delegation = assistant tool_call + tool "Executed"; failed native delegation = assistant tool_call + tool "Execution failed"; delimited delegation = raw completion incl. block; other replies verbatim; no-output turns add no assistant message; note frozen at the seed note (no worker in the spike)',
    turn_set_verbatim: TURNS.map(({ id, text, expect, task, frame }) => ({ id, text, expect, expected_task: task ?? null, frame: !!frame })),
    must_mention_table: Object.fromEntries(TURNS.filter((t) => t.mustMention).map((t) => [t.id, t.mustMention.map(String)])),
    mechanisms: Object.fromEntries(mechanisms.map((m) => [m, {
      system_prompt: systemPrompt(m, SEED_NOTE),
      summary: results[m].summary,
      turns: results[m].turns,
    }])),
    pass_bar_any_met: mechanisms.some((m) => results[m].summary.pass_bar.met),
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 1) + '\n')
  console.log(`\nwrote ${OUT_PATH}`)
  console.log(`pass bar met on >=1 mechanism: ${payload.pass_bar_any_met}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => { console.error('E1 spike failed:', error?.stack ?? error); process.exit(2) })
}
