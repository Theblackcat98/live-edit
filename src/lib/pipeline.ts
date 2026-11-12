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
  Directive,
  OmniTurnResult,
  ToolName,
  TraceRuntime,
  WorkerCall,
} from '../types'
import { numberNoteLines, renderToolCallXml } from './worker'
import type { ParsedToolCall } from './xml'
import { endpointUp } from './bridge'
import { runOmniTurn } from './omni'
import { runWorkerChatTurn, WORKER_CHAT_SAMPLER, type WorkerChatTurnResult } from './workerChat'
import { chatTurnFromOmni, chatTurnFromWorker } from './flow/chatTurn'
import { chatModelName } from './runmode'
import type { RunMode } from './runmode'

export type { PipelineDeps, RunResultSnapshot } from './flow/turnContext'
import {
  createTracePublisher,
  makeTrace,
  type PipelineDeps,
  type TurnContext,
} from './flow/turnContext'
export { buildDictationCall } from './flow/buildCall'
import {
  buildDictationCall,
  buildEffectiveDirective,
  buildPacketCall,
} from './flow/buildCall'
import { createStreamBubble } from './flow/bubble'
import { runSnapshotDirective, snapshotPrecheck } from './flow/snapshotStage'
import { verifyAndExecute } from './flow/verify'

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

export { buildOmniHistory } from './flow/history'
import { buildOmniHistory, CHAT_MEMORY_TURNS, conversationTurns, lastEditRun } from './flow/history'

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
  const snapshotAction = snapshotPrecheck(command)
  if (snapshotAction) {
    await runSnapshotDirective(deps, ctx, snapshotAction)
    return
  }

  // Text-only turn: Omni and the d1 check read the note and command alone.

  const history = buildOmniHistory(deps.messagesRef.current, deps.runsRef.current)
  // The current command is already in the transcript; history is prior turns.
  const priorHistory = history.slice(0, -1)
  // Last-run continuity is edit context for the worker's follow-ups;
  // conversational turns carry no edit state. Only verified and pending runs
  // (real edit attempts) are reported. The Audio front door receives the
  // command and status only — its prompt never replays the execution message.
  const edit = lastEditRun(deps.runsRef.current)
  const lastRun = edit ? { command: edit.command, status: edit.status } : null

  // Provisional streaming bubble: Audio's deltas land here live (battery
  // case 18); the authoritative text replaces them for answer/clarify, and
  // the bubble is retracted entirely when the turn delegates or acts — the
  // delegation must stay silent in the transcript.
  const { onText, retractStream, settleStream } = createStreamBubble(deps, {
    author: chatAuthor,
    runId: traceLocal.id,
  })

  let raw: OmniTurnResult | null
  try {
    raw = await runOmniTurn({
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
  if (!raw) {
    retractStream()
    finish('failed')
    return
  }
  const turn = chatTurnFromOmni(raw)
  runtime.chat = 'live'
  runtime.route = 'live'
  if (turn.repair) traceLocal.omniRepair = turn.repair
  traceLocal.timings.route = turn.ms
  if (turn.promptTokens) {
    traceLocal.promptTokens = turn.promptTokens
    liveUsage.omni = turn.promptTokens
  }
  publish()

  if (turn.outcome === 'answer' || turn.outcome === 'clarify') {
    const text = turn.text ?? ''
    traceLocal.timings.chat = turn.ms
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    // No silent failures: a clarify that exists because the delegation
    // failed validation twice (turn.repair is set only on that path) must
    // SAY the edit failed — a bare clarifying question would read as if
    // nothing went wrong and the note was simply not discussed.
    if (turn.outcome === 'clarify' && turn.repair) {
      deps.addMessage({
        role: 'assistant',
        author: 'harness',
        kind: 'notice',
        text: `That edit didn't go through — the delegation instruction failed validation (${turn.repair.error}). Nothing was changed. The question below is how to retry it.`,
        runId: traceLocal.id,
      })
      deps.notify('Edit failed validation', turn.repair.error, 'error')
    }
    settleStream(text)
    deps.speakReply(text)
    finish(turn.outcome === 'answer' ? 'conversational' : 'clarify')
    return
  }

  if (turn.outcome === 'action') {
    retractStream()
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    deps.setStage('executing')
    const delta = turn.action === 'undo' ? -1 : 1
    const restored = deps.restoreHistory(deps.historyIndexRef.current + delta)
    if (!restored.ok) {
      deps.addMessage({
        role: 'assistant',
        author: 'harness',
        kind: 'result',
        text:
          turn.action === 'undo'
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
      tool: turn.action!,
      note: restored.note,
      durationMs: 0,
      snapshotId: restored.snapshot?.id,
    }
    publish()
    const confirmation =
      turn.action === 'undo'
        ? `Reverted to “${restored.snapshot?.label}”.`
        : `Reapplied “${restored.snapshot?.label}”.`
    deps.addMessage({ role: 'assistant', author: 'harness', kind: 'result', text: confirmation, runId: traceLocal.id })
    deps.speakReply(confirmation)
    finish('verified')
    return
  }

  // --- delegate: worker authors + grounds from the §6 packet ---------------
  const directive = turn.directive
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

  // --- dictation exception (design.md §11) and scaffold/verbatim shaping ---
  const {
    directive: effectiveDirective,
    recovered,
    scaffoldNote,
  } = buildEffectiveDirective(command, directive, noteAtStart)
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

  const decoded = await buildPacketCall({
    directive: effectiveDirective,
    note: noteAtStart,
    runs: deps.runsRef.current,
    recordExchange: ctx.recordExchange,
  })
  traceLocal.timings.generate = decoded.ms
  const call = decoded.call

  if (!call) {
    deps.setStageStates({ A: 'done', B: 'failed', C: 'idle' })
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'error',
      text: `The worker could not produce a valid tool call for that edit (${decoded.error || 'no parseable call'}). Nothing was written to the note, and no fallback content was substituted.`,
      runId: traceLocal.id,
    })
    deps.notify('Worker call invalid', decoded.error || 'No parseable tool call.', 'error')
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
  const snapshotAction = snapshotPrecheck(command)
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
  const lastRun = lastEditRun(deps.runsRef.current)

  // Provisional streaming bubble, same discipline as Audio-first: visible
  // deltas land here live; a call outcome retracts it, an answer settles the
  // authoritative text.
  const { onText, retractStream, settleStream } = createStreamBubble(deps, {
    author: 'LFM3-1.7B',
    runId: traceLocal.id,
  })

  const controller = new AbortController()
  deps.chatAbortRef.current = controller
  let raw: WorkerChatTurnResult
  try {
    raw = await runWorkerChatTurn({
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
    if (raw.outcome === 'invalid') {
      const rejected = raw
      raw = await runWorkerChatTurn({
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
  const turn = chatTurnFromWorker(raw)
  runtime.chat = 'live'
  runtime.route = 'fallback'
  traceLocal.timings.chat = raw.ms
  if (raw.promptTokens) {
    traceLocal.promptTokens = raw.promptTokens
    liveUsage.worker = raw.promptTokens
  }
  if (raw.outputTokens) traceLocal.outputTokens = raw.outputTokens
  publish()

  if (turn?.outcome === 'answer') {
    const text = turn.text ?? ''
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    settleStream(text)
    deps.speakReply(text)
    finish('conversational')
    return
  }

  if (!turn || !turn.call) {
    retractStream()
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    deps.addMessage({
      role: 'assistant',
      kind: 'error',
      author: 'harness',
      text: `The 1.7B could not produce a usable reply after one retry (${
        raw.error ?? 'no parseable tool call and no visible text'
      }). Nothing was written to the note, and no fallback content was substituted.`,
      runId: traceLocal.id,
    })
    deps.notify('Chat reply invalid', raw.error ?? 'No usable reply.', 'error')
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
