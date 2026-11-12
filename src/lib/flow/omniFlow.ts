/**
 * The Audio-first flow (design.md §§2–9): Audio answers, clarifies, or silently
 * delegates a typed directive to the 1.7B worker; undo/redo are deterministic
 * pipeline actions handled before the model runs. The worker authors and
 * grounds its call from the §6 packet, hard gates and the d1 safety check
 * follow, and a disapproved or unavailable check becomes a pending edit.
 */

import type { Directive, OmniTurnResult } from '../../types'
import { d1Decide, endpointUp } from '../bridge'
import { modeDef } from '../modes'
import { OmniTurnError, runOmniTurn } from '../omni'
import { runD1Route, ROUTE_AMBIGUOUS, ROUTE_CONFIDENCE_MIN, ROUTE_CONVERSATIONAL } from '../d1route'
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
  // The registry row names the model actually answering chat in this mode —
  // the reply author label and the front-door endpoint both follow it, never
  // a hardcoded model (legacy `omni` really is served by LFM3-Omni-2B :8083).
  const def = modeDef(mode)
  const chatAuthor = def.chat.author
  const chatEndpoint = def.chat.endpoint
  if (chatEndpoint === 'text') {
    throw new Error(`Mode ${mode} has no front-door chat endpoint.`)
  }
  traceLocal.runMode = mode
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

  // Barge-in: the controller is registered so a new command can cut this
  // stream mid-turn, exactly like the worker-chat flow.
  const controller = new AbortController()
  deps.chatAbortRef.current = controller
  let raw: OmniTurnResult | null
  try {
    raw = await runOmniTurn({
      command,
      source: traceLocal.source,
      history: priorHistory,
      note: noteAtStart,
      lastRun,
      chatEndpoint,
      signal: controller.signal,
      onText,
      onExchange: ctx.recordExchange,
      // Routed Audio flow: Audio answers in plain chat, d1 routes below.
      // Legacy omni keeps the tool-calling front door.
      ...(mode === 'audio' ? { disableTools: true as const } : {}),
    })
  } catch (error) {
    retractStream()
    if (controller.signal.aborted) {
      // Barge-in: the next command already owns the session.
      finish('conversational')
      return
    }
    // OmniTurnError messages already name the model ("LFM3-Audio-2B turn
    // failed: …"); only an unexpected error needs the prefix.
    if (error instanceof OmniTurnError) throw error
    throw new Error(
      `${chatAuthor} turn failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  } finally {
    if (deps.chatAbortRef.current === controller) deps.chatAbortRef.current = null
  }
  if (!raw) {
    retractStream()
    if (controller.signal.aborted) {
      // Barge-in: the next command already owns the session.
      finish('conversational')
      return
    }
    // No silent failure: an empty turn must say so, not just stop.
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'error',
      text: 'The model turn produced no result, so nothing was written to the note.',
      runId: traceLocal.id,
    })
    deps.notify('Chat turn failed', 'The model returned no result.', 'error')
    finish('failed')
    return
  }
  const turn = chatTurnFromOmni(raw)
  runtime.chat = 'live'
  // Legacy Omni decides answer/clarify/delegate/action in the same call, so
  // that call is the route. In audio mode Audio only chats; d1 routes below
  // and records the route stage itself.
  if (mode === 'omni') runtime.route = 'live'
  if (turn.repair) traceLocal.omniRepair = turn.repair
  // One model call is booked to exactly one timing bucket — never both route
  // and chat, or the end-to-end total would count it twice. Answer/clarify
  // (and every audio-mode turn) are chat time; legacy delegate/action are
  // route time.
  if (mode === 'audio' || turn.outcome === 'answer' || turn.outcome === 'clarify') {
    traceLocal.timings.chat = turn.ms
  } else {
    traceLocal.timings.route = turn.ms
  }
  if (turn.promptTokens) {
    traceLocal.promptTokens = turn.promptTokens
    liveUsage.omni = turn.promptTokens
  }
  publish()

  // Routed Audio flow: Audio answered in plain chat (no tools) — d1 decides
  // whether this turn wants an edit. Legacy omni continues below on the
  // tool-calling path.
  if (mode === 'audio') {
    await runAudioRouted(deps, ctx, {
      truncated: turn.truncated === true,
      author: chatAuthor,
      audioText: turn.text ?? '',
      lastRun,
      settleStream,
      retractStream,
    })
    return
  }

  if (turn.outcome === 'answer' || turn.outcome === 'clarify') {
    const text = turn.text ?? ''
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
    if (turn.truncated) addCutOffNotice(deps, traceLocal.id, chatAuthor)
    finish(turn.outcome === 'answer' ? 'conversational' : 'clarify')
    return
  }

  if (turn.outcome === 'action') {
    retractStream()
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    deps.setStage('executing')
    const delta = turn.action === 'undo' ? -1 : 1
    const restoreStarted = performance.now()
    const restored = deps.restoreHistory(deps.historyIndexRef.current + delta)
    traceLocal.timings.execute = Number((performance.now() - restoreStarted).toFixed(1))
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
      durationMs: traceLocal.timings.execute,
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

  // --- delegate: the worker authors + grounds from the directive ------------
  // Legacy omni path only: Audio never reaches here (d1 routes instead).
  const directive = turn.directive
  if (!directive) {
    retractStream()
    throw new Error(`${chatAuthor} delegated without a directive.`)
  }
  retractStream()
  await runWorkerFromDirective(deps, ctx, {
    directive,
    d1Check: def.decide === 'd1',
  })
}

/**
 * The routed Audio turn: Audio answered in plain chat (no tools); d1 reads
 * the command, Audio's reply, and the note outline, and routes edit turns to
 * the worker. Conversation (and ambiguity — never a guess) settles Audio's
 * reply and speaks it.
 */
async function runAudioRouted(
  deps: PipelineDeps,
  ctx: TurnContext,
  opts: {
    audioText: string
    lastRun: { command: string; status: string } | null
    settleStream: (text: string) => void
    retractStream: () => void
    /** Audio's reply stopped at max_tokens. */
    truncated: boolean
    author: string
  },
): Promise<void> {
  const { command, noteAtStart, traceLocal, runtime, publish, finish } = ctx
  const route = await runD1Route({
    command,
    audioReply: opts.audioText,
    note: noteAtStart,
    lastRun: opts.lastRun,
    d1Decide,
  })
  // A route d1 never decided is a fallback, not a live verdict.
  runtime.route = route.error ? 'fallback' : 'live'
  traceLocal.timings.route += route.ms
  // The route verdict is first-class trace data: conversational turns would
  // otherwise leave no record of what d1 decided.
  traceLocal.d1Route = {
    intent: route.intent,
    confidence: route.confidence,
    routesToWorker: route.routesToWorker,
    threshold: ROUTE_CONFIDENCE_MIN,
    ms: route.ms,
    ...(route.promptTokens ? { promptTokens: route.promptTokens } : {}),
    ...(route.error ? { error: route.error } : {}),
  }
  if (route.promptTokens) ctx.liveUsage.d1 = route.promptTokens
  publish()

  if (!route.routesToWorker) {
    deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
    opts.settleStream(opts.audioText)
    deps.speakReply(opts.audioText)
    if (opts.truncated) addCutOffNotice(deps, traceLocal.id, opts.author)
    // Audio answers before d1 routes, and it is prompted to acknowledge
    // change requests. Whenever the turn may have been an edit request but
    // did not reach the worker, that acknowledgement must not be the last
    // word — say plainly that nothing changed and why.
    const notice = unroutedEditNotice(route)
    if (notice) {
      deps.addMessage({
        role: 'assistant',
        author: 'harness',
        kind: 'notice',
        text: notice,
        runId: traceLocal.id,
      })
      if (route.error) deps.notify('Router unavailable', route.error, 'error')
    }
    finish(route.intent === ROUTE_AMBIGUOUS ? 'clarify' : 'conversational')
    return
  }

  // Routed edit: the delegation stays silent like the legacy path — retract
  // the ack bubble, then run the shared worker tail on a harness directive.
  opts.retractStream()
  // The directive is harness-built from the routed task — the worker grounds
  // the span itself, exactly like the legacy delegation, minus Audio's
  // model-authored brief (instruction is the verbatim command; the dictation
  // backstop still recovers quoted spans from it).
  const directive: Directive = { task: route.intent as Directive['task'], instruction: command }
  await runWorkerFromDirective(deps, ctx, {
    directive,
    d1Check: true,
    routedNote: `d1 routed this turn to the worker (intent ${route.intent}, confidence ${route.confidence}).`,
  })
}

/** A reply the server stopped at max_tokens must not pass as complete. */
function addCutOffNotice(deps: PipelineDeps, runId: string, author: string): void {
  deps.addMessage({
    role: 'assistant',
    author: 'harness',
    kind: 'notice',
    text: `${author}'s reply above was cut off at its length limit — it is incomplete.`,
    runId,
  })
}

/**
 * The harness notice for a turn that may have asked for an edit but was not
 * routed to the worker; null for a clear conversational verdict.
 */
export function unroutedEditNotice(route: {
  intent: string
  confidence: number | null
  error?: string
}): string | null {
  if (route.error) {
    return `Nothing was changed: the router (d1) gave no usable answer (${route.error}), so this turn was handled as conversation only. If you asked for an edit, try again once d1 is back.`
  }
  if (route.intent === ROUTE_AMBIGUOUS) {
    return 'Nothing was changed: d1 could not tell whether you wanted the note edited. If you did, say exactly what to change.'
  }
  if (route.intent !== ROUTE_CONVERSATIONAL) {
    const conf = route.confidence === null ? 'unreported' : route.confidence.toFixed(2)
    const article = /^[aeiou]/.test(route.intent) ? 'an' : 'a'
    return `Nothing was changed: d1 read this as ${article} ${route.intent} request but with low confidence (${conf}, needs ${ROUTE_CONFIDENCE_MIN.toFixed(2)}). Say exactly what to change to try again.`
  }
  return null
}

/** Shared worker tail: directive → call (dictation or packet decode) → verify. */
async function runWorkerFromDirective(
  deps: PipelineDeps,
  ctx: TurnContext,
  opts: { directive: Directive; d1Check: boolean; routedNote?: string },
): Promise<void> {
  const { command, noteAtStart, traceLocal, runtime, publish, finish } = ctx
  const directive = opts.directive
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
    await verifyAndExecute(deps, ctx, effectiveDirective, call, {
      d1Check: opts.d1Check,
    })
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
  if (opts.routedNote) {
    call.promptHints.push(opts.routedNote)
  }
  await verifyAndExecute(deps, ctx, effectiveDirective, call, {
    d1Check: opts.d1Check,
  })
}

