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
  ToolName,
  TraceRuntime,
  WorkerCall,
} from '../types'
import { numberNoteLines, renderToolCallXml } from './worker'
import type { ParsedToolCall } from './xml'
import { endpointUp } from './bridge'
import { runWorkerChatTurn, WORKER_CHAT_SAMPLER, type WorkerChatTurnResult } from './workerChat'
import { chatTurnFromWorker } from './flow/chatTurn'
import type { RunMode } from './runmode'

export type { PipelineDeps, RunResultSnapshot } from './flow/turnContext'
import {
  createTracePublisher,
  makeTrace,
  type PipelineDeps,
  type TurnContext,
} from './flow/turnContext'
export { buildDictationCall } from './flow/buildCall'
import { createStreamBubble } from './flow/bubble'
import { runSnapshotDirective, snapshotPrecheck } from './flow/snapshotStage'
import { verifyAndExecute } from './flow/verify'
import { runOmniFirstTurn } from './flow/omniFlow'

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
import { CHAT_MEMORY_TURNS, conversationTurns, lastEditRun } from './flow/history'

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
