/**
 * The Audio-first flow (design.md §§2–9): Audio answers, clarifies, or silently
 * delegates a typed directive to the 1.7B worker; undo/redo are deterministic
 * pipeline actions handled before the model runs. The worker authors and
 * grounds its call from the §6 packet, hard gates and the d1 safety check
 * follow, and a disapproved or unavailable check becomes a pending edit.
 */

import type { OmniTurnResult } from '../../types'
import { endpointUp } from '../bridge'
import { chatModelName } from '../runmode'
import { runOmniTurn } from '../omni'
import { createStreamBubble } from './bubble'
import { buildDictationCall, buildEffectiveDirective, buildPacketCall } from './buildCall'
import { chatTurnFromOmni } from './chatTurn'
import { buildOmniHistory, lastEditRun } from './history'
import { runSnapshotDirective, snapshotPrecheck } from './snapshotStage'
import { verifyAndExecute } from './verify'
import type { PipelineDeps, TurnContext } from './turnContext'

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
export async function runOmniFirstTurn(
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

