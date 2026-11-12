/**
 * Call building for the Audio-first flow: the dictation exception, the
 * template-scaffold/verbatim shaping of the model's directive, and the worker
 * packet decode loop that turns a directive into one validated tool call.
 */

import type { Directive, Trace, TurnExchange, WorkerCall } from '../../types'
import { NOTE_PATH } from '../../data/note'
import { TOOL_BY_NAME, TOOL_DEFS } from '../../data/tools'
import {
  buildPacketWorkerMessages,
  buildWorkerRetryMessages,
  numberNoteLines,
  renderToolCallXml,
  PACKET_WORKER_SAMPLER,
  type PacketWorkerPromptInput,
} from '../worker'
import { buildWorkerPacket } from '../context'
import { recoverDictatedText } from '../dictation'
import { scaffoldTemplateBrief } from '../templateScaffold'
import { parseToolCallXml, type ParsedToolCall } from '../xml'
import { captureExchange, workerExchangeTarget } from '../exchange'
import { chatComplete, type ChatResult } from '../bridge'
import { splitLines } from '../doc'

/**
 * The dictation exception (design.md §11): when Audio's directive carries
 * `verbatim` — exact words the user dictated — the harness builds the
 * add_text call itself. The worker never re-authors dictated text; the
 * call flows through the same gates and d1 check as a worker call.
 */
export function buildDictationCall(directive: Directive, note: string): WorkerCall {
  const heading = directive.target?.heading ?? null
  const params: Record<string, string> = {
    file_path: NOTE_PATH,
    position: heading ? 'under_heading' : 'append',
    ...(heading ? { anchor: heading } : {}),
    content: directive.verbatim as string,
  }
  return {
    name: 'add_text',
    params,
    thought: 'User-dictated exact text — harness-built call (dictation exception); no worker decode.',
    xml: renderToolCallXml('add_text', params),
    rawTokens: 0,
    promptHints: ['Dictation exception: user-quoted exact text, inserted verbatim'],
    toolSchemasInjected: 0,
    noteView: numberNoteLines(note),
  }
}

/** The directive the rest of the turn builds on, plus its provenance notes. */
export interface EffectiveDirective {
  directive: Directive
  /** True when the verbatim was recovered from the command's quoted span. */
  recovered: boolean
  /** The scaffold provenance hint, when the template scaffold fired. */
  scaffoldNote: string | null
}

/**
 * Shape the model's directive before call building.
 *
 * - Dictation backstop (battery case 8f): when the model omits `verbatim` but
 *   the user's command carries the quoted span, recover it deterministically.
 * - Template scaffold (battery cases 27/27b/12/12d): a README-template command
 *   needs the standard section list in the brief; only fires on create-task
 *   README-template commands without a section already named.
 * - Verbatim is insert-shaped: a model-set verbatim on edit/remove tasks is a
 *   mislabel (battery case 6) — null it and return the turn to the worker. A
 *   recovered verbatim always routes to the dictation call (case 8f).
 */
export function buildEffectiveDirective(
  command: string,
  directive: Directive,
  note: string,
): EffectiveDirective {
  const recovered = recoverDictatedText(command, directive)
  const rawEffective = recovered ? { ...directive, verbatim: recovered } : directive
  const scaffolded = scaffoldTemplateBrief(command, rawEffective, note)
  const scaffoldNote =
    scaffolded !== rawEffective
      ? 'Template scaffold: the §13.1 section vocabulary appended to the brief (the model echoed the command instead of packing it).'
      : null
  const effective =
    !recovered &&
    (scaffolded.task === 'edit' || scaffolded.task === 'remove') &&
    typeof scaffolded.verbatim === 'string' &&
    scaffolded.verbatim.trim().length > 0
      ? { ...scaffolded, verbatim: null }
      : scaffolded
  return { directive: effective, recovered: recovered !== null, scaffoldNote }
}

function packetWorkerCall(
  parsed: ParsedToolCall,
  reasoning: string,
  ms: number,
  usagePromptTokens: number,
  usageOutputTokens: number,
  sampler: { temperature: number; maxTokens: number | null },
  note: string,
): WorkerCall {
  return {
    name: parsed.name,
    params: parsed.params,
    thought: parsed.think ?? reasoning ?? `Worker emitted ${parsed.name} from the Audio directive.`,
    xml: renderToolCallXml(parsed.name, parsed.params),
    rawTokens: usageOutputTokens,
    promptHints: [
      `Decoded by LFM3-1.7B · ${(ms / 1000).toFixed(1)}s · ${usagePromptTokens} prompt tokens`,
      `Sent sampler: temperature=${sampler.temperature} · max_tokens=${sampler.maxTokens}`,
      'Audio directive + full line-numbered note + recent edit turns (design.md §6 packet); worker grounds the span itself',
    ],
    toolSchemasInjected: 3,
    noteView: numberNoteLines(note),
    sampler,
  }
}

/**
 * Anchor correction for a worker retry: when an edit_text attempt's
 * `old_text_anchor` doesn't match the note at its own range, hand the retry
 * the note's actual text there (the E4 anchor near-miss class — the one
 * class a retry reliably fixes).
 */
function anchorCorrectionFor(
  note: string,
  parsed: ParsedToolCall | null,
): { startLine: number; endLine: number; actualText: string } | null {
  if (!parsed || parsed.name !== 'edit_text') return null
  const startLine = Number(parsed.params.start_line)
  const endLine = Number(parsed.params.end_line)
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return null
  }
  const actualText = splitLines(note)
    .slice(startLine - 1, endLine)
    .join('\n')
  if (!actualText || actualText === parsed.params.old_text_anchor) return null
  return { startLine, endLine, actualText }
}

export interface PacketCallInput {
  directive: Directive
  /** The note as it was at turn start (read only — never mutated). */
  note: string
  /** Completed runs, for the §6 edit-turn context packet. */
  runs: Trace[]
  /** Turn-exchange recorder (the inspector Chat tab). */
  recordExchange: (exchange: TurnExchange) => void
}

export interface PacketCallResult {
  /** The validated call, or null when neither attempt produced one. */
  call: WorkerCall | null
  /** The last attempt's concrete rejection reason. */
  error: string
  /** Wall time spent decoding, for trace.timings.generate. */
  ms: number
}

/**
 * Decode the directive into one validated tool call from the §6 packet: at
 * most two attempts (packet decode, then a retry carrying the rejected text
 * and the exact parse error). No content is ever invented.
 */
export async function buildPacketCall(input: PacketCallInput): Promise<PacketCallResult> {
  const { directive, note, runs, recordExchange } = input
  const packet = buildWorkerPacket(directive, runs, note)
  const packetInput: PacketWorkerPromptInput = {
    directive,
    contextPacket: packet,
    note,
  }
  const workerStarted = performance.now()
  let call: WorkerCall | null = null
  let attemptError = ''
  let attemptText = ''
  let attemptedTool: WorkerCall['name'] | null = null
  let attemptedParsed: ParsedToolCall | null = null
  for (const sampler of [PACKET_WORKER_SAMPLER.attempt1, PACKET_WORKER_SAMPLER.retry]) {
    // Turn-budget guard (battery case 12b): a slow first attempt (a 6,000-
    // token deliberation can eat most of a turn) must not be followed by a
    // second equally slow one — fail with the concrete error instead of
    // blowing past any sane turn timeout.
    if (attemptText !== '' && performance.now() - workerStarted > 45_000) break
    const messages =
      call === null && attemptText === ''
        ? buildPacketWorkerMessages(packetInput)
        : buildWorkerRetryMessages({
            original: packetInput,
            attemptText,
            error: attemptError,
            attemptedTool,
            anchorCorrection: anchorCorrectionFor(note, attemptedParsed),
          })
    const label = attemptText === '' ? 'packet decode · attempt 1' : 'packet decode · retry'
    let completion: ChatResult
    try {
      completion = await chatComplete('text', messages, sampler)
    } catch (error) {
      // Transport failure (incl. the bridge's 90s timeout): retrying the
      // same dead/slow endpoint inside this turn buys nothing.
      attemptError = error instanceof Error ? error.message : 'worker request failed'
      recordExchange(
        captureExchange({
          role: 'worker',
          label,
          ...workerExchangeTarget(),
          messages,
          stream: false,
          temperature: sampler.temperature,
          maxTokens: sampler.maxTokens,
          tools: TOOL_DEFS.map((tool) => tool.name),
          completion: null,
          error: attemptError,
        }),
      )
      break
    }
    const recordPacketExchange = (error?: string) => {
      recordExchange(
        captureExchange({
          role: 'worker',
          label,
          ...workerExchangeTarget(),
          messages,
          stream: false,
          temperature: sampler.temperature,
          maxTokens: sampler.maxTokens,
          tools: TOOL_DEFS.map((tool) => tool.name),
          completion,
          ...(error ? { error } : {}),
        }),
      )
    }
    attemptText = completion.text
    const xmlInput = /<think>/.test(completion.text)
      ? completion.text
      : completion.reasoning
        ? `<think>${completion.reasoning}</think>\n${completion.text}`
        : completion.text
    const parsed = parseToolCallXml(xmlInput)
    attemptedTool = parsed?.name ?? null
    attemptedParsed = parsed
    if (!parsed) {
      attemptError =
        completion.finishReason === 'length'
          ? `The reply hit the ${sampler.maxTokens}-token output limit before finishing a tool call.`
          : 'The reply did not contain one parseable tool call in the repo XML format.'
      recordPacketExchange(attemptError)
      continue
    }
    const required = TOOL_BY_NAME[parsed.name].params
      .filter((param) => param.required)
      .map((param) => param.name)
    const missing = required.filter((name) => !(parsed.params[name] ?? '').trim())
    if (missing.length > 0) {
      attemptError = `The ${parsed.name} call is missing required parameter(s): ${missing.join(', ')}.`
      recordPacketExchange(attemptError)
      continue
    }
    recordPacketExchange()
    call = packetWorkerCall(
      parsed,
      completion.reasoning ?? '',
      completion.ms,
      completion.usage.promptTokens,
      completion.usage.outputTokens,
      sampler,
      note,
    )
    break
  }
  return {
    call,
    error: attemptError,
    ms: Number((performance.now() - workerStarted).toFixed(1)),
  }
}
