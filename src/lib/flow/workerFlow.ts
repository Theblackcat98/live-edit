/**
 * The worker-chat flow (run modes `worker-d1` and `lowram`): LFM3-1.7B is the
 * chat model itself and authors the tool call. Undo/redo stay deterministic
 * pipeline directives; a prose reply settles the bubble and is spoken; a tool
 * call becomes a Directive and flows through the shared verify/execute tail.
 */

import type { Directive, ToolName, WorkerCall } from '../../types'
import { endpointUp } from '../bridge'
import { modeDef } from '../modes'
import { numberNoteLines, renderToolCallXml } from '../worker'
import { runWorkerChatTurn, WORKER_CHAT_SAMPLER, type WorkerChatTurnResult } from '../workerChat'
import type { ParsedToolCall } from '../xml'
import { createStreamBubble } from './bubble'
import { chatTurnFromWorker } from './chatTurn'
import { CHAT_MEMORY_TURNS, conversationTurns, lastEditRun } from './history'
import { runSnapshotDirective, snapshotPrecheck } from './snapshotStage'
import { verifyAndExecute } from './verify'
import type { PipelineDeps, TurnContext } from './turnContext'

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
export async function runWorkerChatFirstTurn(
  deps: PipelineDeps,
  ctx: TurnContext,
  mode: 'worker-d1' | 'lowram',
): Promise<void> {
  const { command, noteAtStart, traceLocal, runtime, liveUsage, publish, finish } = ctx
  // The registry row names the reply author and the decision policy, never a
  // hardcoded label or a mode comparison.
  const def = modeDef(mode)
  const chatAuthor = def.chat.author
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
    author: chatAuthor,
    runId: traceLocal.id,
  })

  const controller = new AbortController()
  deps.chatAbortRef.current = controller
  let raw: WorkerChatTurnResult
  // Both attempts' wall time — a retry must not erase the first attempt's.
  let attemptsMs = 0
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
    attemptsMs += raw.ms
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
      attemptsMs += raw.ms
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
  // Worker-chat modes have no model route: the 1.7B chats and calls tools itself.
  runtime.route = 'skipped'
  // One 1.7B request answers OR authors the call: book it to exactly one
  // bucket (chat for a reply, generate for a tool call) — never both.
  attemptsMs = Number(attemptsMs.toFixed(1))
  if (turn?.outcome !== 'delegate') traceLocal.timings.chat = attemptsMs
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
  traceLocal.timings.generate = attemptsMs
  traceLocal.call = call
  traceLocal.workerNoteView = call.noteView
  publish()

  // Mode 3 runs no d1: verifyAndExecute holds the gate-passing edit for
  // the user's decision — with no decision model running, nothing may
  // execute silently.
  await verifyAndExecute(deps, ctx, directive, call, {
    d1Check: def.decide === 'd1',
    snapshotLabel: '1.7B tool call',
    flowLabel: 'worker-chat run mode',
  })
}
