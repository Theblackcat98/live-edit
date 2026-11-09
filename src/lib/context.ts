/**
 * Context packet builders (design.md §6, architecture-refactor.md §7 step 1).
 *
 * Pure functions, zero I/O, no React. The harness builds every packet from
 * recorded turns and diffs — assembly is transformation, not authorship: it
 * selects and formats, it never summarizes in prose (design.md §6). Assistant
 * prose is excluded by construction: nothing here reads message text; the
 * worker packet is derived from the directive and the recorded diff alone.
 *
 * Contents:
 * - buildWorkerPacket   the §6 worker context: the last 3 completed edit
 *                       turns as {command, directive summary, diff summary},
 *                       most recent last, plus the packet's prompt-token
 *                       estimate (ContextPacket, types.ts).
 * - buildD1State        the §6/§7 d1 packet as ONE state text blob, mirroring
 *                       the E3-calibrated assembly of
 *                       scripts/spike-d1-check.mjs (buildState) exactly.
 * - renderUnifiedDiff   minimal unified-style diff text from an ExecutionDiff
 *                       (E3's fixtures carried a "rendered unified-style
 *                       diff"; same `- ` / `+ ` line grammar and `@@ … @@`
 *                       header grammar as the spike).
 * - noteHash            cheap, stable content hash for the pending-edit
 *                       staleness rule (design.md §8/§9).
 *
 * E3 fidelity contract (docs/spikes/E3-d1-check.md): the d1 thresholds
 * (noul ≥ 0.50 AND destructive_safety = safe) were calibrated against this
 * exact state text, so buildD1State copies the spike's section ordering and
 * labels byte-for-byte. context.test.ts asserts byte-identity against the
 * state text recorded in docs/spikes/E3-d1-check.json for one fixture per
 * diff kind (edit / remove / insert-under-heading / extract / prepend).
 */

import type {
  ContextPacket,
  Directive,
  EditTurnRecord,
  ExecutionDiff,
  ToolName,
  Trace,
} from '../types'
import { INITIAL_NOTE, NOTE_PATH } from '../data/note'

// --- documented budgets (design.md §6) ------------------------------------------
//
// Worker packet: "Packet ≤ ~600 tokens". Per-record caps keep three records
// well inside that (≈ 460 chars per record ≈ 115 tokens × 3 + framing):
// command ≤ 120 chars, directive summary ≤ 200 chars (§6: "the directives
// themselves, truncated" — the task bar is ≤ ~200 chars), diff summary ≤ 120
// chars (one line).
const WORKER_PACKET_MAX_TURNS = 3
const COMMAND_MAX_CHARS = 120
const DIRECTIVE_SUMMARY_MAX_CHARS = 200
const DIFF_SUMMARY_MAX_CHARS = 120

// d1 packet: "Tightest packet in the system" (design.md §6). The current
// command travels verbatim (calibrated; the E3 packet carried it untruncated)
// and the directive JSON travels whole (the §5 schema is its budget: a brief,
// not content). The only discretionary inputs are bounded:
// lastUserTurn ≤ 600 chars (the shipped chat discipline's per-turn cap) and
// the rendered diff ≤ 200 lines — far above anything E3 calibrated (a 42-line
// note renders ≤ ~90 diff lines), bounding pathology only for giant notes.
const D1_LAST_TURN_MAX_CHARS = 600
const D1_MAX_DIFF_LINES = 200

/**
 * Prompt-token estimate: chars / 4, rounded up. Documented heuristic (the
 * task allows char/4); the packet's honest assembly-time estimate, not a
 * measured count. Deliberately NOT utils.estimateTokens (word-count blend) —
 * this module keeps one fixed, documented rule so packet estimates are
 * comparable across builders.
 */
function estimateTokensByChars(text: string): number {
  if (!text.length) return 0
  return Math.ceil(text.length / 4)
}

/** Collapse all whitespace runs to single spaces (summaries are one line). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** One-line truncated summary; ellipsis keeps the result ≤ max characters. */
function summarize(text: string, maxChars: number): string {
  const clean = oneLine(text)
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`
}

// --- buildWorkerPacket -----------------------------------------------------------

/** One-line diff summary in the §6 shape, e.g. `edit_text lines 17–17: 1 line replaced`. */
function diffSummary(tool: ToolName, diff: ExecutionDiff): string {
  const start = diff.startLine
  const end = start + Math.max(diff.removed, 1) - 1
  const plural = (n: number) => `${n} line${n === 1 ? '' : 's'}`
  let text: string
  if (tool === 'edit_text') {
    // En dash in ranges here is deliberate — it matches the §6 record shape
    // ("edit_text lines 17–17: 1 line replaced"); the d1 state's `@@ … @@`
    // headers use the spike's plain hyphen instead.
    const replaced = plural(diff.removed)
    text =
      diff.added === diff.removed
        ? `${tool} lines ${start}–${end}: ${replaced} replaced`
        : `${tool} lines ${start}–${end}: ${replaced} replaced with ${plural(diff.added)}`
  } else if (tool === 'remove_text') {
    text = `${tool} lines ${start}–${end}: ${plural(diff.removed)} removed`
  } else {
    const endLine = start + diff.added - 1
    text = `${tool} lines ${start}–${endLine}: ${plural(diff.added)} inserted`
  }
  return summarize(text, DIFF_SUMMARY_MAX_CHARS)
}

/** The exact framing whose chars/4 estimate promptTokens reports. */
function renderPacketForEstimate(editTurns: EditTurnRecord[]): string {
  return editTurns
    .map((turn) => `${turn.command} | ${turn.directiveSummary} | ${turn.diffSummary}`)
    .join('\n')
}

/**
 * The §6 worker context packet: the last **3 completed edit turns**, most
 * recent LAST, each distilled to `{command, directive summary, diff summary}`.
 *
 * A completed edit turn is a recorded run with status `verified`, an
 * execution diff (a real edit landed — undo/redo carry no diff and never
 * appear), and a directive (the summary channel; a legacy run without one
 * cannot be distilled and is not invented here). `runs` may be in any order —
 * recency is decided by the runs' `at` timestamps (stable sort keeps the
 * hook's newest-first list order on ties).
 *
 * Assistant prose is excluded by construction: the builder reads only
 * `command`, `directive.instruction` and `execution.diff` off the trace; chat
 * text, acks, completions and worker thoughts are never touched.
 *
 * The `directive` and `note` parameters pin the documented §7.1 call shape —
 * they are the rest of the worker's context (design.md §6: "The directive +
 * context packet … + the full line-numbered note") but travel with the prompt
 * itself (worker.ts, P3), NOT inside this packet, per the ContextPacket
 * contract in types.ts. They are deliberately unread here.
 */
export function buildWorkerPacket(
  _directive: Directive,
  runs: Trace[],
  _note: string,
): ContextPacket {
  const completedEditTurns = runs
    .filter(
      (run) =>
        run.status === 'verified' &&
        run.directive != null &&
        run.execution != null &&
        run.execution.diff != null,
    )
    // Newest first regardless of the caller's ordering…
    .sort((a, b) => b.at - a.at)
    .slice(0, WORKER_PACKET_MAX_TURNS)
    // …then oldest of the three first, so the most recent turn lands last.
    .reverse()

  const editTurns: EditTurnRecord[] = completedEditTurns.map((run) => ({
    command: summarize(run.command, COMMAND_MAX_CHARS),
    directiveSummary: summarize(run.directive?.instruction ?? '', DIRECTIVE_SUMMARY_MAX_CHARS),
    diffSummary: diffSummary(run.execution!.tool as ToolName, run.execution!.diff!),
  }))

  return {
    editTurns,
    promptTokens: estimateTokensByChars(renderPacketForEstimate(editTurns)),
  }
}

// --- buildD1State ----------------------------------------------------------------

/**
 * The proposed worker call as the d1 state carries it: `{name, arguments}` —
 * the same shape the shipped critic state (pipeline.ts buildCriticState) and
 * the E3 spike serialize. WorkerCall satisfies this (its string `params`
 * serialize verbatim; the E3 fixtures happened to carry numeric line values —
 * both are passed through untouched).
 */
export interface D1ProposedCall {
  name: ToolName
  params: Record<string, unknown>
}

export interface D1StateInput {
  /** The typed Omni directive (§5), serialized whole as JSON. */
  directive: Directive
  /** The user's current command — verbatim, never truncated (calibrated). */
  command: string
  /** The proposed call (see D1ProposedCall). */
  call: D1ProposedCall
  /** The diff rendered against the note the call was authored against. */
  diff: ExecutionDiff
  /** §6's "at most the last user turn" — optional, bounded, context only. */
  lastUserTurn?: string
  /**
   * Path of the note the diff was rendered against. Defaults to the app's
   * note path, which is what the E3 packet carried.
   */
  notePath?: string
  /**
   * Content-line count of the note the diff was rendered against (the count
   * the removal header reports: "N of M content lines"). Callers should pass
   * the live count; the default is the seed note's, reproducing the E3
   * seed-note packet exactly.
   */
  noteLineCount?: number
}

/**
 * The fixed preamble, verbatim from the E3 spike (scripts/spike-d1-check.mjs
 * buildState). The frame sentence describes the IMAGE the bridge attaches
 * alongside this blob — the frame itself never enters the state text (the
 * bridge sends `{state, images: [dataUrl], questions}`; P4's d1check passes
 * the resolved frame the same way). Kept byte-identical to E3, including the
 * "synthetic operating-review slide" wording, because the calibrated
 * thresholds are only valid while this packet stays fixed; a live-frame
 * variant would be a calibration-affecting change and is not introduced here.
 */
const D1_STATE_PREAMBLE =
  'Safety check for a proposed note edit. You are given the directive from the interface model, the user command, the worker\'s proposed tool call, and the rendered diff of that call against the current note. The current video frame (a synthetic operating-review slide) is attached.'

/**
 * Content-line count of the seed note — the value the E3 packet reported
 * (42). Computed with the spike's own rule: a trailing newline yields a final
 * empty splitLines entry that is not a content line.
 */
export const SEED_NOTE_LINE_COUNT = (() => {
  const lines = INITIAL_NOTE.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
})()

/**
 * Render the diff section the way the E3 spike's renderDiff did, using the
 * call's parameters for the `@@ … @@` header (the same clause shapes the
 * spike sent) and the ExecutionDiff for the lines. Byte-identical to the
 * spike for any (call, diff) executeTool would produce, given the correct
 * noteLineCount — asserted against the recorded E3 fixture states in
 * context.test.ts.
 */
function renderD1Diff(call: D1ProposedCall, diff: ExecutionDiff, noteLineCount: number): string {
  const start = diff.startLine
  const end = start + Math.max(diff.removed, 1) - 1
  if (call.name === 'edit_text') {
    return [
      `@@ lines ${start}-${end} replaced @@`,
      ...diff.before.map((line) => `- ${line}`),
      ...diff.after.map((line) => `+ ${line}`),
    ].join('\n')
  }
  if (call.name === 'remove_text') {
    return [
      `@@ lines ${start}-${end} removed (${diff.removed} of ${noteLineCount} content lines) @@`,
      ...diff.before.map((line) => `- ${line}`),
    ].join('\n')
  }
  // add_text / extract_visual_to_note: the spike's `where` clause. prepend is
  // fixed text; everything else is an under-heading insert, and the engine's
  // insertUnderHeading always separates the block from the section's last
  // content line with exactly one blank line (tools.ts), so that line is
  // diff.startLine - 2 — the same number the spike computed from the note.
  const position = call.params.position
  if (position === 'prepend') {
    return [
      '@@ insert top of the note (before line 1) @@',
      ...diff.after.map((line) => `+ ${line}`),
    ].join('\n')
  }
  const headingTitle = (call.params.anchor ?? call.params.anchor_heading) as string | undefined
  const where = headingTitle
    ? `under heading "${headingTitle}" (after line ${start - 2})`
    : `at line ${start}`
  return [`@@ insert ${where} @@`, ...diff.after.map((line) => `+ ${line}`)].join('\n')
}

/**
 * The §6/§7 d1 packet as ONE state text blob, byte-mirroring the E3-calibrated
 * assembly (scripts/spike-d1-check.mjs buildState) — section order and labels
 * exactly: preamble, typed directive as indented JSON, the user command
 * verbatim (JSON-stringified on one line), the proposed call as indented
 * `{name, arguments}` JSON, and the rendered unified-style diff. d1 judges
 * call↔directive fit, not conversation (design.md §6), so `lastUserTurn` is
 * the only conversational input, optional, bounded, and clearly labelled; the
 * E3-calibrated sections keep their exact relative order whether it is
 * present or not.
 *
 * The video frame does NOT go in the blob — the bridge attaches it as an
 * image (`images: [dataUrl]`) next to this state text; the preamble's frame
 * sentence refers to that attachment.
 *
 * Returns the state text only. Token estimates are the caller's concern (the
 * string return has nowhere to report one; every input that can grow is
 * bounded by the documented budgets above).
 */
export function buildD1State(input: D1StateInput): string {
  const {
    directive,
    command,
    call,
    diff,
    lastUserTurn,
    notePath = NOTE_PATH,
    noteLineCount = SEED_NOTE_LINE_COUNT,
  } = input

  const diffLines = renderD1Diff(call, diff, noteLineCount).split('\n')
  const diffText =
    diffLines.length > D1_MAX_DIFF_LINES
      ? [
          ...diffLines.slice(0, D1_MAX_DIFF_LINES),
          `… (diff truncated to the first ${D1_MAX_DIFF_LINES} of ${diffLines.length} lines)`,
        ].join('\n')
      : diffLines.join('\n')

  const state: string[] = [
    D1_STATE_PREAMBLE,
    '',
    'Directive (typed, from the interface model):',
    JSON.stringify(directive, null, 2),
    '',
    `User command (verbatim): ${JSON.stringify(command)}`,
  ]
  if (lastUserTurn != null) {
    state.push('', `Last user turn (context): ${JSON.stringify(summarize(lastUserTurn, D1_LAST_TURN_MAX_CHARS))}`)
  }
  state.push(
    '',
    'Proposed tool call (from the worker):',
    JSON.stringify({ name: call.name, arguments: call.params }, null, 2),
    '',
    `Rendered diff against the current note (${notePath}, ${noteLineCount} content lines):`,
    diffText,
  )
  return state.join('\n')
}

// --- renderUnifiedDiff ------------------------------------------------------------

/**
 * Minimal unified-style rendering of an ExecutionDiff — the same `- ` / `+ `
 * line grammar and `@@ … @@` header grammar the E3 spike sent, with headers
 * computable from the diff alone (no call, no note): replacement, removal
 * (with the removed-line count; the spike's "of M content lines" tail needs
 * the note, which this signature deliberately does not take — buildD1State's
 * call-aware renderer adds it), and insertion. An empty diff renders as an
 * empty string.
 */
export function renderUnifiedDiff(diff: ExecutionDiff): string {
  const start = diff.startLine
  const end = start + Math.max(diff.removed, 1) - 1
  const before = diff.before.map((line) => `- ${line}`)
  const after = diff.after.map((line) => `+ ${line}`)
  if (before.length && after.length) {
    return [`@@ lines ${start}-${end} replaced @@`, ...before, ...after].join('\n')
  }
  if (before.length) {
    return [`@@ lines ${start}-${end} removed (${diff.removed} lines) @@`, ...before].join('\n')
  }
  if (after.length) {
    const plural = `${diff.added} line${diff.added === 1 ? '' : 's'}`
    return [`@@ insert at line ${start} (${plural}) @@`, ...after].join('\n')
  }
  return ''
}

// --- noteHash ---------------------------------------------------------------------

/**
 * Normalize a note for hashing. Documented normalizations, and only these:
 * (1) CRLF and lone CR → LF; (2) leading/trailing whitespace of every line
 * stripped; (3) leading/trailing blank lines of the note dropped. Internal
 * whitespace and internal blank lines are significant (they shift line
 * numbers, which is exactly what staleness cares about). The staleness hash
 * is a cheap pre-filter anyway — §8 makes anchor exactness against the
 * current note the deciding gate on ✓.
 */
function normalizeForHash(note: string): string {
  const lines = note.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim())
  while (lines.length && lines[0] === '') lines.shift()
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/**
 * FNV-1a, 32-bit, over the UTF-16 code units of the normalized note
 * (offset basis 0x811c9dc5, prime 0x01000193). Pure string arithmetic — no
 * Math.random, no Date — so the hash is stable across reloads (decision D3:
 * pending edits persist, and their stored note_hash must still match).
 * 32 bits is deliberately cheap; collisions are acceptable for a staleness
 * pre-filter that the anchor gate decides.
 *
 * Signature is fixed at `(note: string) => string` — parallel modules build
 * against it. Returns 8 lowercase hex digits.
 */
export function noteHash(note: string): string {
  const normalized = normalizeForHash(note)
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
