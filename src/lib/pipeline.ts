/**
 * The turn pipeline. runPipelineTurn is the single entry point for one
 * user turn, dispatched by the run mode captured at turn start:
 *
 *   runOmniFirstTurn      modes `audio`/`omni`: Audio (or legacy Omni) answers/clarifies/acts, or
 *                         delegates a typed directive to the 1.7B worker
 *   runWorkerChatFirstTurn modes `worker-d1` / `lowram`: the 1.7B chats
 *                         and authors the tool call itself
 *
 * Both mutation paths share verifyAndExecute: deterministic hard gates,
 * the engine dry-run diff, then the d1 decision model — approved edits
 * execute silently; disapproved/unavailable (and every edit in lowram,
 * which runs no decision model) become pending edits for the user.
 * Undo/redo are deterministic snapshot directives (snapshotDirective.ts),
 * never model decisions.
 *
 * The hook supplies every session capability through PipelineDeps and
 * keeps only session state (note/messages/history, persistence, voice,
 * TTS, demo mode, toasts) for itself. The supervisor-first pipeline that
 * used to live here was deleted with supervisor.ts — no heuristic router,
 * no template authoring, no canned replies remain in the turn path.
 */

import type {
  ContextUsage,
  D1CheckResult,
  DelegationInfo,
  Directive,
  ExecutionDiff,
  Message,
  OmniTurnResult,
  PendingEdit,
  Probability,
  ToolName,
  Trace,
  TraceRuntime,
  TurnHold,
  WorkerCall,
} from '../types'
import { NOTE_PATH } from '../data/note'
import { TOOL_BY_NAME, TOOL_DEFS } from '../data/tools'
import {
  buildPacketWorkerMessages,
  buildWorkerRetryMessages,
  numberNoteLines,
  renderToolCallXml,
  PACKET_WORKER_SAMPLER,
  type PacketWorkerPromptInput,
} from './worker'
import { executeTool } from './tools'
import { recoverDictatedText } from './dictation'
import { scaffoldTemplateBrief } from './templateScaffold'
import { sectionScaleCollapse } from './blastGate'
import { checkExecutionOutcome } from './executionCheck'
import { detectSnapshotDirective } from './snapshotDirective'
import { runOmniTurn, type OmniHistoryTurn } from './omni'
import { runWorkerChatTurn, WORKER_CHAT_SAMPLER, type WorkerChatTurnResult } from './workerChat'
import { chatModelName } from './runmode'
import type { RunMode } from './runmode'
import { buildD1State, buildWorkerPacket, noteHash } from './context'
import { runHardGates } from './gates'
import { runD1Check } from './d1check'
import { createPendingEdit } from './pending'
import { parseToolCallXml, type ParsedToolCall } from './xml'
import { captureExchange, workerExchangeTarget } from './exchange'
import {
  chatComplete,
  d1Decide,
  endpointUp,
  type ChatResult,
} from './bridge'
import { splitLines } from './doc'

export type { PipelineDeps, RunResultSnapshot } from './flow/turnContext'
import {
  createTracePublisher,
  makeTrace,
  type PipelineDeps,
  type TurnContext,
} from './flow/turnContext'

/**
 * Recent (user command, assistant reply) pairs replayed as chat turns.
 * A turn with no visible assistant reply contributes only its command.
 */
interface ChatTurn {
  command: string
  reply?: string
}

/** How many prior turns the conversational model sees. */
const CHAT_MEMORY_TURNS = 6

/**
 * Pair each user message with the last assistant reply before the next user
 * message. A trailing user turn (the command being submitted) has no reply yet
 * and is therefore never replayed as history.
 */
function conversationTurns(messages: Message[], limit: number): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'user' || !message.text.trim()) continue
    let reply: Message | null = null
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor]
      if (candidate.role === 'user') break
      if (candidate.role === 'assistant' && candidate.text.trim()) reply = candidate
    }
    turns.push({
      command: message.text,
      reply: reply?.text,
    })
  }
  return turns.slice(-limit)
}

/**
 * Runs one user turn through the stage machine. This is the single entry
 * point for a turn — new turn-level branches insert at the top of this
 * function.
 */
export async function runPipelineTurn(
  deps: PipelineDeps,
  rawCommand: string,
  source: 'text' | 'voice' | 'demo' = 'text',
): Promise<void> {
  const command = rawCommand.trim()
  if (!command) return

  // Barge-in: a new command owns the session. Cut any in-flight chat stream
  // and any spoken audio (model TTS fetch, audio element, browser voice)
  // before this run starts processing.
  deps.chatAbortRef.current?.abort()
  deps.chatAbortRef.current = null
  deps.stopSpeech()

  if (deps.busyRef.current) {
    deps.notify('Worker is busy', 'Wait for the current verified call to finish before queuing another.', 'neutral')
    return
  }

  deps.busyRef.current = true
  deps.setBusy(true)
  deps.setCommandInput('')
  deps.setSourceMode(false)
  if (deps.recorderRef.current) deps.stopMic()
  if (deps.idleTimerRef.current) {
    window.clearTimeout(deps.idleTimerRef.current)
    deps.idleTimerRef.current = null
  }
  deps.clearTransientHighlights()
  deps.setDiff(null)
  deps.setStage('routing')
  deps.setStageStates({ A: 'running', B: 'idle', C: 'idle' })
  deps.setFlowModel('d1')

  const noteAtStart = deps.noteRef.current
  const traceLocal = makeTrace(command, source, noteAtStart)
  deps.setTrace(traceLocal)
  deps.traceRef.current = traceLocal
  deps.addMessage({
    role: 'user',
    text: command,
    source,
    durationSec: source === 'text' ? undefined : deps.lastVoiceSecondsRef.current,
  })

  const { publish, finish, recordExchange, isClosed } = createTracePublisher(deps, traceLocal)

  const runtime: TraceRuntime = {
    route: 'fallback',
    worker: 'fallback',
    critic: 'fallback',
    chat: 'fallback',
  }
  if (source === 'voice') runtime.asr = deps.asrSourceRef.current
  deps.asrSourceRef.current = 'fallback'
  traceLocal.runtime = runtime
  const liveUsage: Partial<ContextUsage> = {}

  const ctx: TurnContext = {
    command,
    noteAtStart,
    traceLocal,
    runtime,
    liveUsage,
    publish,
    finish,
    recordExchange,
  }

  try {
    // Captured once at turn start: a mode switch mid-turn must never swap the
    // models under an in-flight turn. `audio` and `omni` share the
    // runOmniTurn front door (the chat default selects the member); the
    // worker-chat modes route below.
    const mode = deps.modeRef.current
    if (mode === 'omni' || mode === 'audio') {
      await runOmniFirstTurn(deps, ctx, mode)
      return
    }
    await runWorkerChatFirstTurn(deps, ctx, mode)
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown orchestrator failure.'
    if (!isClosed()) {
      traceLocal.status = 'failed'
      deps.addMessage({
        role: 'assistant',
        author: 'harness',
        kind: 'error',
        text: `I stopped the run: ${message} Nothing was written to the note.`,
      })
      deps.notify('Run stopped', message, 'error')
      finish('failed')
    }
  } finally {
    if (deps.busyRef.current) {
      deps.busyRef.current = false
      deps.setBusy(false)
      deps.setStage('idle')
      deps.setFlowModel(null)
    }
  }
}

/**
 * Audio's history (design.md §6), assembled from the transcript and the
 * recorded runs: answer turns contribute their visible reply; delegation
 * turns contribute the recorded directive as a tool record — never harness
 * prose, never another turn's internals.
 */
export function buildOmniHistory(messages: Message[], runs: Trace[]): OmniHistoryTurn[] {
  const runsById = new Map(runs.map((run) => [run.id, run]))
  const turns: OmniHistoryTurn[] = []
  let current: OmniHistoryTurn | null = null
  for (const message of messages) {
    if (message.role === 'user') {
      current = { command: message.text }
      turns.push(current)
      continue
    }
    if (!current) continue
    // Delegation cards are 'tool' messages; replies are 'assistant' ones.
    if (message.role !== 'assistant' && message.role !== 'tool') continue
    const run = message.runId ? runsById.get(message.runId) : undefined
    if (message.delegation && run?.directive && !current.delegation) {
      current.delegation = {
        tool: 'delegate_edit',
        arguments: JSON.stringify(run.directive),
        result: run.status === 'verified' ? 'Executed' : 'Execution failed',
      }
    } else if (!current.reply && !current.delegation && message.text && message.kind !== 'error') {
      // Execution/result confirmations belong to a run (runId set) — they
      // are harness prose, never model-authored chat. Accept one as the
      // turn's reply only when it carries no run pairing (an unpaired
      // confirmation has no delegation to hang off, so dropping it would
      // lose the turn entirely); a run-paired confirmation whose run also
      // produced a delegation card contributes nothing beyond the tool
      // record (battery case 21: replaying it visibly taught the front
      // door plain-text delegation, measured 4/4 server-side).
      const pairedRun = message.runId ? runsById.get(message.runId) : undefined
      if (message.role === 'assistant' && message.runId && pairedRun?.directive) continue
      current.reply = message.text
    }
  }
  return turns.filter((turn) => turn.command.trim().length > 0)
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

/** Rejected-trace record for a worker-authored call the harness refused. */
function recordOmniRejection(
  deps: PipelineDeps,
  ctx: TurnContext,
  directive: Directive,
  call: WorkerCall,
  reason: string,
  pCorrect: Probability,
): void {
  deps.setRejectedTraces((previous) => [
    ...previous,
    {
      at: Date.now(),
      command: ctx.command,
      route: {
        tool: call.name,
        provenance:
          ctx.traceLocal.runMode && ctx.traceLocal.runMode !== 'audio' && ctx.traceLocal.runMode !== 'omni'
            ? 'worker-chat run mode'
            : 'audio-first pipeline',
      },
      grounding: { source: 'worker-self' },
      workerXml: call.xml,
      critic: { verdict: 'rejected', reason, pCorrect },
      directive,
    },
  ])
}

/**
 * The Audio-first turn (design.md §§2–9). One model is
 * the interface: Audio answers, clarifies, or silently
 * delegates a typed directive to the 1.7B worker (undo/redo are
 * deterministic pipeline actions, handled before the model runs). The worker authors and
 * grounds its call from the §6 packet; deterministic hard gates run next;
 * d1's only job is the §7 safety check; a disapproved or unavailable check
 * becomes a pending edit for the user — never a dead end, never a silent
 * approval. No stage invents content: there is no template fallback here.
 */
async function runOmniFirstTurn(
  deps: PipelineDeps,
  ctx: TurnContext,
  mode: 'audio' | 'omni',
): Promise<void> {
  const { command, noteAtStart, traceLocal, runtime, liveUsage, publish, finish } = ctx
  // The model actually answering chat this turn — the reply author label and
  // the front-door endpoint both follow the captured mode, never a hardcoded
  // model (legacy `omni` really is served by LFM3-Omni-2B :8083).
  const chatAuthor = chatModelName(mode)
  const chatEndpoint = mode === 'omni' ? 'omni' : 'audio'
  deps.setFlowModel('omni')
  deps.setStage('routing')

  // Deterministic undo/redo pre-check (battery case 10b): snapshot rollback
  // is a pipeline action, never a model decision — the worker-chat modes
  // already pre-check, and this path relied on the model emitting
  // harness_action, which is how 'redo it' got answered conversationally
  // while 'undo that' happened to be classified. Same detector, same
  // rationale (design.md §2/§9).
  const snapshotAction = detectSnapshotDirective(command)
  if (snapshotAction) {
    await runSnapshotDirective(deps, ctx, snapshotAction)
    return
  }

  // Text-only turn: Omni and the d1 check read the note and command alone.

  const history = buildOmniHistory(deps.messagesRef.current, deps.runsRef.current)
  // The current command is already in the transcript; history is prior turns.
  const priorHistory = history.slice(0, -1)
  // Last-run continuity is edit context for the worker's follow-ups —
  // conversational/chat turns carry no edit state, and replaying one
  // ("Last completed run: hey → conversational") teaches the front door
  // that chat turns are delegations (measured: greeting delegated 3/3
  // with the line present, answered 3/3 without it). Only verified and
  // pending runs (real edit attempts) are reported.
  const lastEditRun = deps.runsRef.current.find(
    (run) => run.status === 'verified' || run.status === 'pending',
  )
  const lastRun = lastEditRun
    ? {
        command: lastEditRun.command,
        status: lastEditRun.status,
      }
    : null

  // Provisional streaming bubble: Audio's deltas land here live (battery
  // case 18); the authoritative text replaces them for answer/clarify, and
  // the bubble is retracted entirely when the turn delegates or acts — the
  // delegation must stay silent in the transcript.
  let streamId: string | null = null
  let streamedText = ''
  const onText = (delta: string) => {
    streamedText += delta
    if (!streamId) {
      streamId = deps.addMessage({
        role: 'assistant',
        text: streamedText,
        author: chatAuthor,
        runId: traceLocal.id,
      })
    } else {
      deps.patchMessage(streamId, { text: streamedText })
    }
  }
  const retractStream = () => {
    if (streamId) {
      const id = streamId
      deps.setMessages((previous) => previous.filter((message) => message.id !== id))
      streamId = null
      streamedText = ''
    }
  }
  const settleStream = (text: string) => {
    if (streamId) {
      deps.patchMessage(streamId, { text })
      streamId = null
    } else {
      deps.addMessage({ role: 'assistant', text, author: chatAuthor, runId: traceLocal.id })
    }
  }

  let omni: OmniTurnResult | null
  try {
    omni = await runOmniTurn({
      command,
      source: traceLocal.source,
      history: priorHistory,
      note: noteAtStart,
      lastRun,
      chatEndpoint,
      onText,
      onExchange: ctx.recordExchange,
    })
  } catch (error) {
    retractStream()
    throw new Error(
      `Omni turn failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
  if (!omni) {
    retractStream()
    finish('failed')
    return
  }
  runtime.chat = 'live'
  runtime.route = 'live'
  if (omni.repair) traceLocal.omniRepair = omni.repair
  traceLocal.timings.route = omni.ms
  if (omni.promptTokens) {
    traceLocal.promptTokens = omni.promptTokens
    liveUsage.omni = omni.promptTokens
  }
  publish()

  if (omni.outcome === 'answer' || omni.outcome === 'clarify') {
    const text = omni.text ?? ''
    traceLocal.timings.chat = omni.ms
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    // No silent failures: a clarify that exists because the delegation
    // failed validation twice (omni.repair is set only on that path) must
    // SAY the edit failed — a bare clarifying question would read as if
    // nothing went wrong and the note was simply not discussed.
    if (omni.outcome === 'clarify' && omni.repair) {
      deps.addMessage({
        role: 'assistant',
        author: 'harness',
        kind: 'notice',
        text: `That edit didn't go through — the delegation instruction failed validation (${omni.repair.error}). Nothing was changed. The question below is how to retry it.`,
        runId: traceLocal.id,
      })
      deps.notify('Edit failed validation', omni.repair.error, 'error')
    }
    settleStream(text)
    deps.speakReply(text)
    finish(omni.outcome === 'answer' ? 'conversational' : 'clarify')
    return
  }

  if (omni.outcome === 'action') {
    retractStream()
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    deps.setStage('executing')
    const delta = omni.action === 'undo' ? -1 : 1
    const restored = deps.restoreHistory(deps.historyIndexRef.current + delta)
    if (!restored.ok) {
      deps.addMessage({
        role: 'assistant',
        author: 'harness',
        kind: 'result',
        text:
          omni.action === 'undo'
            ? 'There is nothing to undo yet — the note is at its first snapshot.'
            : 'There is nothing to redo. The note is already at the latest snapshot.',
        runId: traceLocal.id,
      })
      finish('conversational')
      return
    }
    traceLocal.execution = {
      ok: true,
      message: restored.message,
      tool: omni.action!,
      note: restored.note,
      durationMs: 0,
      snapshotId: restored.snapshot?.id,
    }
    publish()
    const confirmation =
      omni.action === 'undo'
        ? `Reverted to “${restored.snapshot?.label}”.`
        : `Reapplied “${restored.snapshot?.label}”.`
    deps.addMessage({ role: 'assistant', author: 'harness', kind: 'result', text: confirmation, runId: traceLocal.id })
    deps.speakReply(confirmation)
    finish('verified')
    return
  }

  // --- delegate: worker authors + grounds from the §6 packet ---------------
  const directive = omni.directive
  if (!directive) {
    retractStream()
    throw new Error(`${chatAuthor} delegated without a directive.`)
  }
  retractStream()
  traceLocal.directive = directive
  publish()
  deps.setStageStates({ A: 'done', B: 'running', C: 'idle' })
  deps.setStage('generating')
  deps.setFlowModel('worker')

  // --- dictation exception (design.md §11): exact user-dictated text is
  // built by the harness, never authored by the worker. The call still
  // flows through the hard gates and the d1 check like any other; the
  // trace records the provenance honestly (runtime.worker = 'dictation').
  // Backstop (battery case 8f): when the model omits `verbatim` but the
  // user's own command carries the quoted span, recover it
  // deterministically — the dictated text must never depend on the model
  // remembering to label it.
  const recovered = recoverDictatedText(command, directive)
  const rawEffective = recovered ? { ...directive, verbatim: recovered } : directive
  // Template scaffold (battery cases 27/27b/12/12d — design.md §13.1): a
  // README-template command needs the standard section list in the brief,
  // and the model echoes the command instead of packing it (measured live:
  // instruction == command, worker authors 1–3 of the 5 barred sections).
  // The scaffold appends the fixed section vocabulary to the instruction —
  // scaffolding, not content: the worker still authors every word. Only
  // fires on create-task README-template commands without a section
  // already named, so real user briefs are never rewritten.
  const scaffolded = scaffoldTemplateBrief(command, rawEffective, noteAtStart)
  const scaffoldNote =
    scaffolded !== rawEffective
      ? 'Template scaffold: the §13.1 section vocabulary appended to the brief (the model echoed the command instead of packing it).'
      : null
  // Verbatim is insert-shaped: exact words to put into the note. A
  // MODEL-set verbatim on edit/remove tasks is a mislabel (battery case
  // 6: a "$1.45M Final" value update packed as verbatim routes the
  // harness-built add_text instead of the worker's edit_text, and d1
  // rightly disapproves the mismatch) — null it and return the turn to
  // the worker, whose instruction already quotes the values. A RECOVERED
  // verbatim is the harness's own finding from the command's quoted span:
  // it always routes to the dictation call, whatever the task (battery
  // case 8f: an add-line command the model tasked as edit still carries
  // a dictated line — the worker would paraphrase it). Dictation with a
  // model-set verbatim on insert/create (e.g. 8f's classic shape) flows
  // through untouched.
  const effectiveDirective =
    !recovered &&
    (scaffolded.task === 'edit' || scaffolded.task === 'remove') &&
    typeof scaffolded.verbatim === 'string' &&
    scaffolded.verbatim.trim().length > 0
      ? { ...scaffolded, verbatim: null }
      : scaffolded
  if (effectiveDirective !== directive) {
    traceLocal.directive = effectiveDirective
    publish()
  }
  if (
    typeof effectiveDirective.verbatim === 'string' &&
    effectiveDirective.verbatim.trim().length > 0
  ) {
    const call = buildDictationCall(effectiveDirective, noteAtStart)
    if (recovered) {
      call.promptHints.push(
        'Dictation backstop: verbatim recovered from the quoted span in the user command — the model omitted the field (battery case 8f).',
      )
    }
    runtime.worker = 'dictation'
    traceLocal.timings.generate = 0
    traceLocal.call = call
    traceLocal.workerNoteView = call.noteView
    publish()
    await verifyAndExecute(deps, ctx, effectiveDirective, call)
    return
  }

  if (!endpointUp(deps.healthRef.current, 'text')) {
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'error',
      text: 'The worker model (LFM3-1.7B) is offline, so the delegated edit cannot run. Nothing was written to the note.',
      runId: traceLocal.id,
    })
    deps.notify('Worker offline', 'The delegated edit was not run.', 'error')
    finish('failed')
    return
  }

  const packet = buildWorkerPacket(effectiveDirective, deps.runsRef.current, noteAtStart)
  const packetInput: PacketWorkerPromptInput = {
    directive: effectiveDirective,
    contextPacket: packet,
    note: noteAtStart,
  }
  const workerStarted = performance.now()
  let call: WorkerCall | null = null
  let attemptError = ''
  let attemptText = ''
  let attemptedTool: ToolName | null = null
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
            anchorCorrection: anchorCorrectionFor(noteAtStart, attemptedParsed),
          })
    const label = attemptText === '' ? 'packet decode · attempt 1' : 'packet decode · retry'
    let completion: ChatResult
    try {
      completion = await chatComplete('text', messages, sampler)
    } catch (error) {
      // Transport failure (incl. the bridge's 90s timeout): retrying the
      // same dead/slow endpoint inside this turn buys nothing.
      attemptError = error instanceof Error ? error.message : 'worker request failed'
      ctx.recordExchange(
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
      ctx.recordExchange(
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
      attemptError = 'The reply did not contain one parseable tool call in the repo XML format.'
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
      noteAtStart,
    )
    break
  }
  traceLocal.timings.generate = Number((performance.now() - workerStarted).toFixed(1))

  if (!call) {
    deps.setStageStates({ A: 'done', B: 'failed', C: 'idle' })
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'error',
      text: `The worker could not produce a valid tool call for that edit (${attemptError || 'no parseable call'}). Nothing was written to the note, and no fallback content was substituted.`,
      runId: traceLocal.id,
    })
    deps.notify('Worker call invalid', attemptError || 'No parseable tool call.', 'error')
    finish('failed')
    return
  }
  runtime.worker = 'live'
  traceLocal.call = call
  traceLocal.workerNoteView = call.noteView
  publish()

  if (scaffoldNote) {
    call.promptHints.push(scaffoldNote)
  }
  await verifyAndExecute(deps, ctx, effectiveDirective, call)
}

/** The directive task that matches a tool the 1.7B already chose (task only). */
const TASK_FOR_TOOL: Record<ToolName, Directive['task']> = {
  add_text: 'insert',
  edit_text: 'edit',
  remove_text: 'remove',
}

/** Honest WorkerCall provenance for a live 1.7B chat-turn decode. */
function workerChatCall(
  parsed: ParsedToolCall,
  reasoning: string,
  ms: number,
  promptTokens: number,
  outputTokens: number,
  note: string,
): WorkerCall {
  return {
    name: parsed.name,
    params: parsed.params,
    thought:
      parsed.think ??
      (reasoning.trim() || `Worker emitted ${parsed.name} from the chat turn.`),
    xml: renderToolCallXml(parsed.name, parsed.params),
    rawTokens: outputTokens,
    promptHints: [
      `Decoded by LFM3-1.7B · ${(ms / 1000).toFixed(1)}s · ${promptTokens} prompt tokens`,
      `Sent sampler: temperature=${WORKER_CHAT_SAMPLER.temperature} · max_tokens=${WORKER_CHAT_SAMPLER.maxTokens ?? 'uncapped'}`,
      'Run-mode chat turn: the 1.7B chose the tool itself from the note context; no Audio directive exists in this mode.',
    ],
    toolSchemasInjected: 3,
    noteView: numberNoteLines(note),
    sampler: { ...WORKER_CHAT_SAMPLER },
  }
}

/**
 * The worker-chat turn (run modes `worker-d1` and `lowram`): LFM3-1.7B is
 * the chat model itself and authors the tool call. Undo/redo stay
 * deterministic pipeline directives — snapshot rollback is never a model
 * decision, the same rationale as Audio-first. A prose reply settles the
 * bubble and is spoken; a tool call becomes a Directive synthesized from the
 * command and flows through the shared verifyAndExecute tail: d1's §7
 * safety check in `worker-d1`; in `lowram` there is no d1 call at all —
 * the hard gates run, then the edit is held for the user (no decision
 * model means no silent execution).
 */
async function runWorkerChatFirstTurn(
  deps: PipelineDeps,
  ctx: TurnContext,
  mode: Exclude<RunMode, 'omni'>,
): Promise<void> {
  const { command, noteAtStart, traceLocal, runtime, liveUsage, publish, finish } = ctx
  traceLocal.runMode = mode
  deps.setFlowModel('worker')
  deps.setStage('routing')

  // Deterministic undo/redo pre-check: same pipeline-directive rationale as
  // the Audio-first path.
  const snapshotAction = detectSnapshotDirective(command)
  if (snapshotAction) {
    await runSnapshotDirective(deps, ctx, snapshotAction)
    return
  }

  // --- worker offline: honest failure, nothing invented ---------------------
  if (!endpointUp(deps.healthRef.current, 'text')) {
    deps.addMessage({
      role: 'assistant',
      kind: 'error',
      author: 'harness',
      text: 'The chat model (LFM3-1.7B) is offline, so this turn cannot run. Nothing was written to the note.',
      runId: traceLocal.id,
    })
    deps.notify('Worker offline', 'LFM3-1.7B is not answering on :8080.', 'error')
    finish('failed')
    return
  }

  const history = conversationTurns(deps.messagesRef.current, CHAT_MEMORY_TURNS)
  // The current command is already in the transcript; history is prior turns.
  const priorHistory = history.slice(0, -1)
  const lastEdit = deps.runsRef.current.find(
    (run) => run.status === 'verified' || run.status === 'pending',
  )
  const lastRun = lastEdit
    ? {
        command: lastEdit.command,
        status: lastEdit.status,
        ...(lastEdit.execution?.message ? { message: lastEdit.execution.message } : {}),
      }
    : null

  // Provisional streaming bubble, same discipline as Audio-first: visible
  // deltas land here live; a call outcome retracts it, an answer settles the
  // authoritative text.
  let streamId: string | null = null
  let streamedText = ''
  const onText = (delta: string) => {
    streamedText += delta
    if (!streamId) {
      streamId = deps.addMessage({
        role: 'assistant',
        text: streamedText,
        streaming: true,
        author: 'LFM3-1.7B',
        runId: traceLocal.id,
      })
    } else {
      deps.patchMessage(streamId, { text: streamedText })
    }
  }
  const retractStream = () => {
    if (streamId) {
      const id = streamId
      deps.setMessages((previous) => previous.filter((message) => message.id !== id))
      streamId = null
      streamedText = ''
    }
  }
  const settleStream = (text: string) => {
    if (streamId) {
      deps.patchMessage(streamId, { text, streaming: false })
      streamId = null
    } else {
      deps.addMessage({ role: 'assistant', text, author: 'LFM3-1.7B', runId: traceLocal.id })
    }
  }

  const controller = new AbortController()
  deps.chatAbortRef.current = controller
  let turn: WorkerChatTurnResult
  try {
    turn = await runWorkerChatTurn({
      command,
      history: priorHistory,
      note: noteAtStart,
      lastRun,
      signal: controller.signal,
      onText,
      onExchange: ctx.recordExchange,
    })
    // One retry on an unusable reply: the rejected text and the exact parse
    // error are appended (the packet-worker retry pattern), never a guess.
    if (turn.outcome === 'invalid') {
      const rejected = turn
      turn = await runWorkerChatTurn({
        command,
        history: priorHistory,
        note: noteAtStart,
        lastRun,
        signal: controller.signal,
        onText,
        onExchange: ctx.recordExchange,
        retry: { attemptText: rejected.raw, error: rejected.error ?? 'no usable reply' },
      })
    }
  } catch (error) {
    retractStream()
    if (controller.signal.aborted) {
      // Barge-in: the next command already owns the session.
      finish('conversational')
      return
    }
    const detail = error instanceof Error ? error.message : 'unknown error'
    deps.addMessage({
      role: 'assistant',
      kind: 'error',
      author: 'harness',
      text: `The 1.7B chat turn failed: ${detail} Nothing was written to the note.`,
      runId: traceLocal.id,
    })
    deps.notify('Chat turn failed', detail, 'error')
    finish('failed')
    return
  } finally {
    if (deps.chatAbortRef.current === controller) deps.chatAbortRef.current = null
  }

  // The chat turn is served by the 1.7B itself; routing was the deterministic
  // undo/redo pre-check above, so no model route call is claimed.
  runtime.chat = 'live'
  runtime.route = 'fallback'
  traceLocal.timings.chat = turn.ms
  if (turn.promptTokens) {
    traceLocal.promptTokens = turn.promptTokens
    liveUsage.worker = turn.promptTokens
  }
  if (turn.outputTokens) traceLocal.outputTokens = turn.outputTokens
  publish()

  if (turn.outcome === 'answer') {
    const text = turn.text ?? ''
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    settleStream(text)
    deps.speakReply(text)
    finish('conversational')
    return
  }

  if (turn.outcome === 'invalid' || !turn.call) {
    retractStream()
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    deps.addMessage({
      role: 'assistant',
      kind: 'error',
      author: 'harness',
      text: `The 1.7B could not produce a usable reply after one retry (${
        turn.error ?? 'no parseable tool call and no visible text'
      }). Nothing was written to the note, and no fallback content was substituted.`,
      runId: traceLocal.id,
    })
    deps.notify('Chat reply invalid', turn.error ?? 'No usable reply.', 'error')
    finish('failed')
    return
  }

  // --- delegate: synthesize the Directive, then the shared verify tail ------
  const parsed = turn.call
  retractStream()
  // No Omni brief exists in these modes. Only the required fields are filled
  // (task from the tool the 1.7B already chose, instruction verbatim); the
  // model grounded the span itself, so no target/verbatim is invented.
  const directive: Directive = {
    task: TASK_FOR_TOOL[parsed.name],
    instruction: command,
  }
  traceLocal.directive = directive
  deps.setStageStates({ A: 'done', B: 'done', C: 'idle' })
  deps.setStage('generating')
  deps.setFlowModel('worker')
  const call = workerChatCall(
    parsed,
    turn.think ?? '',
    turn.ms,
    turn.promptTokens ?? 0,
    turn.outputTokens ?? 0,
    noteAtStart,
  )
  runtime.worker = 'live'
  traceLocal.timings.generate = turn.ms
  traceLocal.call = call
  traceLocal.workerNoteView = call.noteView
  publish()

  // Mode 3 runs no d1: verifyAndExecute holds the gate-passing edit for
  // the user's decision — with no decision model running, nothing may
  // execute silently.
  await verifyAndExecute(deps, ctx, directive, call, {
    d1Check: mode === 'worker-d1',
    snapshotLabel: '1.7B tool call',
  })
}

/**
 * The shared tail of every Audio-first mutation (worker-authored or
 * dictation-built): delegation card, deterministic hard gates, the engine
 * dry-run that renders the diff, the d1 safety check, then execute — or a
 * pending edit when d1 disapproves or is unavailable.
 *
 * `options.d1Check: false` is the low-RAM path: the d1 server does not run
 * in that mode. Silent edits are the decision model's job — with no
 * decision model running, nothing may execute silently, so the edit is
 * held as a pending edit for the user (the user IS the decision layer in
 * this mode) instead of executing directly.
 */

/** Hold a gate-passing call as a pending edit for the user's decision. */
function holdForUserDecision(
  deps: PipelineDeps,
  ctx: TurnContext,
  delegation: DelegationInfo,
  delegationId: string,
  directive: Directive,
  call: WorkerCall,
  diff: ExecutionDiff,
  d1: PendingEdit['d1'],
  confidence: number | null,
  heldText: string,
  notifyDetail: string,
  hold: TurnHold,
  overrideBlastRadius?: true,
): void {
  const { traceLocal, publish, finish } = ctx
  // Insertion calls carry no line range for adjudication to check drift
  // against, so record the insertion neighbourhood (authoring note lines
  // either side of the diff's insertion point) as their staleness anchor.
  const insertion =
    call.name === 'add_text'
      ? (() => {
          const lines = splitLines(ctx.noteAtStart)
          const startLine = diff.startLine
          return {
            startLine,
            precedingLine: startLine >= 2 ? (lines[startLine - 2] ?? null) : null,
            followingLine: lines[startLine - 1] ?? null,
          }
        })()
      : undefined
  const pending = createPendingEdit({
    directive,
    call,
    diff,
    noteHash: noteHash(ctx.noteAtStart),
    ...(insertion ? { insertion } : {}),
    d1,
    ...(overrideBlastRadius ? { overrideBlastRadius: true } : {}),
  })
  traceLocal.hold = hold
  publish()
  deps.addPendingEdit(pending)
  deps.patchMessage(delegationId, {
    delegation: { ...delegation, status: 'pending', confidence },
  })
  traceLocal.status = 'pending'
  deps.addMessage({ role: 'assistant', author: 'harness', kind: 'notice', text: heldText, runId: traceLocal.id })
  deps.notify('Edit waiting for your decision', notifyDetail, 'neutral')
  deps.speakReply('That edit needs your call. It is waiting under pending edits.')
  finish('pending')
}
async function verifyAndExecute(
  deps: PipelineDeps,
  ctx: TurnContext,
  directive: Directive,
  call: WorkerCall,
  options: { d1Check: boolean; snapshotLabel?: string } = { d1Check: true },
): Promise<void> {
  const { command, noteAtStart, traceLocal, runtime, publish, finish } = ctx

  const delegation: DelegationInfo = {
    runId: traceLocal.id,
    tool: call.name,
    status: 'checking',
    modelLabel: runtime.worker === 'dictation' ? 'dictation' : '1.7B',
    thought: directive.instruction,
  }
  const delegationId = deps.addMessage({
    role: 'tool',
    text: '',
    runId: traceLocal.id,
    delegation,
  })

  // --- hard gates (design.md §8): correctness refusals are never adjudicable.
  // The blast-radius cap is a destructiveness limit, not a correctness check:
  // when it is the ONLY failure the call is held for the user's decision
  // (approval executes with the cap waived — a human overrode it, on record).
  // Stage C is the d1 check; in low-RAM mode there is no d1, so it is never
  // marked as having run.
  deps.setStageStates({ A: 'done', B: 'done', C: options.d1Check ? 'running' : 'skipped' })
  deps.setStage('verifying')
  const gates = runHardGates(noteAtStart, call)
  if (!gates.pass) {
    const detail = gates.failures.map((failure) => failure.detail).join(' ')
    const blastOnly =
      gates.failures.length > 0 &&
      gates.failures.every(
        (failure) => failure.gate === 'destructive_safety' || failure.gate === 'blast_radius',
      )
    if (blastOnly) {
      // Dry-run with the cap waived: the card (and approval) run on the
      // real diff, so the user sees exactly what the override would do.
      const overridePreview = executeTool(noteAtStart, call, { overrideBlastRadius: true })
      if (overridePreview.ok && overridePreview.diff) {
        holdForUserDecision(
          deps,
          ctx,
          delegation,
          delegationId,
          directive,
          call,
          overridePreview.diff,
          {
            verdict: 'unavailable',
            noul: null,
            destructiveSafety: null,
            reason: `${detail} Approving executes the removal with the limit waived — you decide.`,
          },
          null,
          `I won't run that removal silently: ${detail} It removes ${overridePreview.diff.removed} of ${
            splitLines(noteAtStart).length
          } note lines. It is held under Pending edits — approve it there to run it anyway, or discard it.`,
          'Blast-radius hold: removal beyond the limit, awaiting your decision.',
          { kind: 'blast-radius', reason: detail },
          true,
        )
        return
      }
    }
    deps.patchMessage(delegationId, { delegation: { ...delegation, status: 'rejected' } })
    recordOmniRejection(deps, ctx, directive, call, `Hard gates failed: ${detail}`, null)
    traceLocal.hold = { kind: 'hard-gate', reason: detail }
    publish()
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'error',
      text: `I stopped before execution. A deterministic hard gate refused this call: ${detail} The note was not touched.`,
      runId: traceLocal.id,
    })
    deps.notify('Hard gate refusal', detail, 'error')
    finish('rejected')
    return
  }

  // Dry-run the engine for the diff the safety check (and any pending card) renders.
  const preview = executeTool(noteAtStart, call)
  if (!preview.ok || !preview.diff) {
    deps.patchMessage(delegationId, { delegation: { ...delegation, status: 'rejected' } })
    recordOmniRejection(deps, ctx, directive, call, preview.message, null)
    traceLocal.hold = { kind: 'engine', reason: preview.message }
    publish()
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'error',
      text: `I stopped before writing. ${preview.message} The note was not changed.`,
      runId: traceLocal.id,
    })
    deps.notify('Execution stopped', preview.message, 'error')
    // A dry-run refusal is a refusal, not a failure: the harness declined
    // the call before writing (delegation already patched 'rejected', the
    // rejection already recorded) — the run settles 'rejected' so the
    // terminal matches the evidence (battery case 12c).
    finish('rejected')
    return
  }

  // --- no decision model in this mode: the user decides ---------------------
  // Low-RAM runs no d1, so there is no security layer that could approve a
  // silent edit. The gate-passing call is held for the user instead of
  // executing — visible, adjudicable, never silent in either direction.
  if (!options.d1Check) {
    holdForUserDecision(
      deps,
      ctx,
      delegation,
      delegationId,
      directive,
      call,
      preview.diff,
      {
        verdict: 'unavailable',
        noul: null,
        destructiveSafety: null,
        reason:
          'Low-RAM mode runs no decision model (d1), so no edit executes silently in this mode — this one needs your decision.',
      },
      null,
      'Low-RAM mode runs no safety-check model, so this edit is held for your decision under Pending edits instead of executing on its own. The note was not touched.',
      'No decision model in low-RAM mode; held for adjudication.',
      {
        kind: 'no-decision-model',
        reason: 'Low-RAM mode runs no decision model (d1) — every gate-passing edit is held for the user.',
      },
    )
    return
  }

  // --- d1 safety check (design.md §7): its only job -------------------------
  let check: D1CheckResult | null = null
  if (options.d1Check) {
    deps.setFlowModel('d1')
    const noteLines = splitLines(noteAtStart)
    const noteLineCount = noteLines.length - (noteLines[noteLines.length - 1] === '' ? 1 : 0)
    const userCommands = deps.messagesRef.current.filter((message) => message.role === 'user')
    const lastUserTurn =
      userCommands.length >= 2 ? userCommands[userCommands.length - 2].text : undefined
    check = await runD1Check({
      state: buildD1State({
        directive,
        command,
        call: { name: call.name, params: call.params },
        diff: preview.diff,
        lastUserTurn,
        noteLineCount,
      }),
      d1Decide,
    })
    traceLocal.d1Check = check
    traceLocal.timings.critic = check.ms ?? 0
    runtime.critic = check.verdict === 'unavailable' ? 'fallback' : 'live'
    publish()

    if (check.verdict !== 'approved') {
      holdForUserDecision(
        deps,
        ctx,
        delegation,
        delegationId,
        directive,
        call,
        preview.diff,
        {
          verdict: check.verdict,
          noul: check.noul,
          destructiveSafety: check.destructiveSafety,
          ...(check.reason ? { reason: check.reason } : {}),
        },
        check.noul,
        check.verdict === 'unavailable'
          ? 'The safety check was unavailable, so this edit is held for your decision rather than decided automatically. It is waiting under Pending edits — the note was not touched.'
          : 'The safety check disapproved this edit, but it passed every deterministic gate, so it is held for your decision under Pending edits instead of being dropped. The note was not touched.',
        check.verdict === 'unavailable'
          ? 'd1 unavailable; held for adjudication.'
          : 'd1 disapproved; held for adjudication.',
        {
          kind: 'd1',
          reason: check.reason ?? `d1 verdict: ${check.verdict}.`,
        },
      )
      return
    }
  }

  // --- §8 blast-radius hold (issue #58; battery cases 12c/29): reaching this
  // point means d1 approved. For a section-scale collapse that approval is
  // necessary but not sufficient — the class never executes silently, so it
  // goes to the user with d1's verdict recorded on the card.
  if (check) {
    const collapse = sectionScaleCollapse(noteAtStart, preview.diff, call.name, directive.task, command)
    if (collapse) {
      holdForUserDecision(
        deps,
        ctx,
        delegation,
        delegationId,
        directive,
        call,
        preview.diff,
        {
          verdict: check.verdict,
          noul: check.noul,
          destructiveSafety: check.destructiveSafety,
          ...(check.reason ? { reason: check.reason } : {}),
        },
        check.noul,
        `This edit ${collapse.reason}. That class of edit never runs silently (§8), so it is held for your decision under Pending edits — the note was not touched.`,
        'Blast-radius hold (§8): section-scale collapse held for adjudication despite d1 approval.',
        { kind: 'blast-collapse', reason: collapse.reason },
      )
      return
    }
  }

  // --- d1 approved: execute (the silent path, guarded by the decision model) --
  const confidence = check?.noul ?? null

  // --- outcome tripwires (battery case 8): 'verified' must mean the result
  // matches what was asked, at least where that is deterministically
  // checkable. A no-change execution is reported as-is, never certified; a
  // content mismatch is a visible failure and the note is NOT committed.
  const outcome = checkExecutionOutcome(noteAtStart, directive, call, preview)
  if (outcome.kind === 'missing-content') {
    deps.patchMessage(delegationId, { delegation: { ...delegation, status: 'rejected' } })
    recordOmniRejection(
      deps,
      ctx,
      directive,
      call,
      `Execution outcome check failed: ${outcome.reason}`,
      confidence,
    )
    traceLocal.hold = { kind: 'outcome', reason: outcome.reason }
    publish()
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'error',
      text: `I stopped before writing. ${outcome.reason} The note was not changed.`,
      runId: traceLocal.id,
    })
    deps.notify('Execution stopped', outcome.reason, 'error')
    finish('failed')
    return
  }
  if (outcome.kind === 'no-change') {
    deps.patchMessage(delegationId, {
      delegation: { ...delegation, status: 'executed', confidence },
    })
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'result',
      text: preview.message,
      runId: traceLocal.id,
    })
    finish('conversational')
    return
  }

  deps.setStageStates({ A: 'done', B: 'done', C: options.d1Check ? 'done' : 'skipped' })
  deps.patchMessage(delegationId, {
    delegation: { ...delegation, status: 'verified', confidence },
  })
  deps.setStage('executing')
  deps.setFlowModel('worker')
  const execStarted = performance.now()
  const execution = preview
  traceLocal.timings.execute = Number((performance.now() - execStarted).toFixed(1))
  traceLocal.execution = execution
  // Snapshot labels surface in user-visible messages (undo/redo
  // confirmations quote them — battery case 25 forbids pipeline stage
  // vocabulary in the transcript). "Audio edit" names the provenance
  // without the stage noun; worker-chat modes pass their own label.
  const snapshot = deps.commitNote(
    execution.note,
    `${options.snapshotLabel ?? 'Audio edit'} · ${call.name}`,
    call.name,
  )
  execution.snapshotId = snapshot.id
  deps.setDiff(execution.diff ?? null)
  deps.patchMessage(delegationId, {
    delegation: { ...delegation, status: 'executed', confidence },
  })
  traceLocal.status = 'verified'
  publish()
  deps.addMessage({
    role: 'assistant',
    author: 'harness',
    kind: 'result',
    text: execution.message,
    runId: traceLocal.id,
  })
  deps.speakReply(execution.message)
  finish('verified')
  deps.scheduleHighlightClear()
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

/** Undo/redo: snapshot rollback short-circuits the model stages. */
async function runSnapshotDirective(
  deps: PipelineDeps,
  ctx: TurnContext,
  action: 'undo' | 'redo',
): Promise<void> {
  const { traceLocal, publish, finish } = ctx
  deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
  deps.setStage('executing')
  deps.setFlowModel(null)
  const directiveStarted = performance.now()
  const delta = action === 'undo' ? -1 : 1
  const restored = deps.restoreHistory(deps.historyIndexRef.current + delta)
  traceLocal.timings.execute = Number((performance.now() - directiveStarted).toFixed(1))
  if (!restored.ok) {
    traceLocal.status = 'conversational'
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'result',
      text:
        action === 'undo'
          ? 'There is nothing to undo yet — the note is at its first snapshot.'
          : 'There is nothing to redo. The note is already at the latest snapshot.',
      runId: traceLocal.id,
    })
    finish('conversational')
    return
  }
  traceLocal.execution = {
    ok: true,
    message: restored.message,
    tool: action,
    note: restored.note,
    durationMs: traceLocal.timings.execute,
    snapshotId: restored.snapshot?.id,
  }
  publish()
  const confirmation =
    action === 'undo'
      ? `Reverted to “${restored.snapshot?.label}”. The note is back to the previous verified snapshot — no model inference needed.`
      : `Reapplied “${restored.snapshot?.label}”. Snapshot ${deps.historyIndexRef.current} is active again.`
  deps.addMessage({
    role: 'assistant',
    author: 'harness',
    kind: 'result',
    text: confirmation,
    runId: traceLocal.id,
  })
  deps.speakReply(confirmation)
  finish('verified')
}
