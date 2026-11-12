/**
 * The turn pipeline entry point. runPipelineTurn owns the turn shell — barge-in,
 * the busy gate, session reset, the trace, runtime provenance, and dispatch —
 * and hands the turn to one composable flow:
 *
 *   flow/omniFlow.ts      modes `audio`/`omni`: Audio (or legacy Omni) answers,
 *                         clarifies, acts, or delegates a typed directive to
 *                         the 1.7B worker.
 *   flow/workerFlow.ts    modes `worker-d1` / `lowram`: the 1.7B chats and
 *                         authors the tool call itself.
 *
 * Both flows share the stages under src/lib/flow/: the streaming bubble, the
 * prior-turn history, the deterministic snapshot directive, call building, the
 * common ChatTurnResult, and verifyAndExecute (hard gates, engine dry-run, d1
 * safety check, then execute or hold as a pending edit). Undo/redo are
 * deterministic snapshot directives, never model decisions.
 *
 * The hook supplies every session capability through PipelineDeps and keeps
 * only session state (note/messages/history, persistence, voice, TTS, demo
 * mode, toasts) for itself.
 */

import type { ContextUsage, TraceRuntime } from '../types'
import {
  createTracePublisher,
  makeTrace,
  type PipelineDeps,
  type TurnContext,
} from './flow/turnContext'
import { runOmniFirstTurn } from './flow/omniFlow'
import { runWorkerChatFirstTurn } from './flow/workerFlow'

export type { PipelineDeps, RunResultSnapshot } from './flow/turnContext'
export { buildDictationCall } from './flow/buildCall'
export { buildOmniHistory } from './flow/history'
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
