/**
 * Per-turn context shared by every pipeline stage: the trimmed command, the
 * note as it was when the turn started, the mutable trace, the run's
 * provenance labels, the measured live token usage, and the trace publishers.
 *
 * The hook supplies every session capability through PipelineDeps and keeps
 * only session state (note/messages/history, persistence, voice, TTS, demo
 * mode, toasts) for itself.
 */

import type {
  ContextUsage,
  Directive,
  ExecutionDiff,
  Message,
  PendingEdit,
  PipelineStage,
  Probability,
  RejectedTraceRecord,
  RunStatus,
  RuntimeHealth,
  RuntimeSource,
  Snapshot,
  StageId,
  StageState,
  Toast,
  Trace,
  TraceRuntime,
  TurnExchange,
  WorkerCall,
} from '../../types'
import type { RunMode } from '../runmode'
import { estimateTokens, makeId } from '../utils'
import type { VoiceRecorder } from '../speech'

/** Result of a snapshot-stack restore, as the hook's restoreHistory reports it. */
export interface RunResultSnapshot {
  ok: boolean
  message: string
  snapshot?: Snapshot
  note: string
}

/**
 * Every hook capability the turn pipeline uses, as explicit dependencies.
 * The hook owns the state; the pipeline reads and updates it only through
 * these.
 */
export interface PipelineDeps {
  // --- session refs (kept current by the hook across renders) ---------------
  /** True while a turn is executing; the busy gate and the finally path read and write it. */
  busyRef: { current: boolean }
  /** Latest note text; the turn grounds against the value at its start. */
  noteRef: { current: string }
  /** Current snapshot-stack index; drives the undo/redo directive deltas. */
  historyIndexRef: { current: number }
  /** Completed runs (newest first); the conversational branch cites the latest. */
  runsRef: { current: Trace[] }
  /** Transcript messages; the conversational branch replays recent turns as memory. */
  messagesRef: { current: Message[] }
  /** Latest runtime health; decides which model paths go live instead of fallback. */
  healthRef: { current: RuntimeHealth | null }
  /**
   * Active run mode, kept current by the hook. Read once at turn start: a
   * switch mid-turn must never change the in-flight turn's models.
   */
  modeRef: { current: RunMode }
  /** Where the last voice capture was transcribed; recorded on the run's trace. */
  asrSourceRef: { current: RuntimeSource }
  /** Duration of the last voice capture, recorded on the user message. */
  lastVoiceSecondsRef: { current: number | undefined }
  /** In-flight chat stream controller; aborted on barge-in, reassigned per stream. */
  chatAbortRef: { current: AbortController | null }
  /** Idle-stage reset timer; rescheduled when a run finishes. */
  idleTimerRef: { current: number | null }
  /** Latest trace, mirrored out of React state for synchronous readers. */
  traceRef: { current: Trace | null }
  /** Active microphone capture, stopped when a turn starts. */
  recorderRef: { current: VoiceRecorder | null }

  // --- state setters ----------------------------------------------------------
  /** Busy flag for the UI while a turn runs. */
  setBusy: (busy: boolean) => void
  /** Composer text, cleared when a turn starts. */
  setCommandInput: (value: string) => void
  /** Source-edit pane, closed when a turn starts. */
  setSourceMode: (value: boolean) => void
  /** Execution diff highlight on the note. */
  setDiff: (diff: ExecutionDiff | null) => void
  /** Pipeline stage chip; finish() also uses the updater form. */
  setStage: (stage: PipelineStage | ((current: PipelineStage) => PipelineStage)) => void
  /** A/B/C stage chips. */
  setStageStates: (states: Record<StageId, StageState>) => void
  /** Which model currently owns the flow rail. */
  setFlowModel: (model: 'omni' | 'd1' | 'worker' | null) => void
  /** Live trace of the running turn. */
  setTrace: (trace: Trace) => void
  /** Completed-run list (newest first, capped at 24). */
  setRuns: (runs: Trace[]) => void
  /** Transcript updates: drops the empty bubble when a stream aborts before its first token. */
  setMessages: (update: (previous: Message[]) => Message[]) => void
  /** Rolling context-usage estimate after each branch. */
  setContextUsage: (update: (previous: ContextUsage) => ContextUsage) => void
  /** Rejected-call records shown in the trace drawer. */
  setRejectedTraces: (update: (previous: RejectedTraceRecord[]) => RejectedTraceRecord[]) => void
  /** Store a pending edit for user adjudication (design.md §9); the hook owns the queue. */
  addPendingEdit: (pending: PendingEdit) => void

  // --- message and history mutators -------------------------------------------
  /** Append a transcript message; returns its id. */
  addMessage: (message: Omit<Message, 'id' | 'at'> & { at?: number; id?: string }) => string
  /** Patch a transcript message in place (streamed text, delegation cards). */
  patchMessage: (id: string, patch: Partial<Message>) => void
  /** Snapshot-stack rollback used by the undo/redo directives. */
  restoreHistory: (targetIndex: number) => RunResultSnapshot
  /** Commit a note edit as a new snapshot; returns the snapshot. */
  commitNote: (nextNote: string, label: string, tool: string) => Snapshot
  /** Toast notifications for rejections, stops and busy refusals. */
  notify: (title: string, detail?: string, tone?: Toast['tone']) => void

  // --- voice and highlight plumbing -------------------------------------------
  /** Stop any spoken audio (model TTS fetch, audio element, browser voice). */
  stopSpeech: () => void
  /** Stop an active microphone capture when a turn starts. */
  stopMic: () => void
  /** Drop transient note highlights immediately when a turn starts. */
  clearTransientHighlights: () => void
  /** Speak an assistant reply when the speaker is on. */
  speakReply: (text: string) => void
  /** Fade the diff highlight out after a successful execution. */
  scheduleHighlightClear: () => void
}

/** Per-turn state shared by every stage. */
export interface TurnContext {
  command: string
  noteAtStart: string
  traceLocal: Trace
  runtime: TraceRuntime
  liveUsage: Partial<ContextUsage>
  publish: () => void
  finish: (status: RunStatus) => void
  /** Records one model exchange on the trace (inspector Chat tab) and publishes. */
  recordExchange: (exchange: TurnExchange) => void
}

export function makeTrace(
  command: string,
  source: 'text' | 'voice' | 'demo',
  note: string,
): Trace {
  return {
    id: makeId('run'),
    at: Date.now(),
    command,
    source,
    timings: { route: 0, generate: 0, critic: 0, execute: 0, total: 0 },
    status: 'running',
    outputTokens: 0,
    promptTokens: estimateTokens(note) + 180,
    noteTokensAtStart: estimateTokens(note),
    workerNoteView: '',
    exchanges: [],
  }
}

/** The trace publishers a turn owns: live copies, terminal close, exchanges. */
export interface TracePublisher {
  publish: () => void
  finish: (status: RunStatus) => void
  recordExchange: (exchange: TurnExchange) => void
  /** True once finish() has closed the run. */
  isClosed: () => boolean
}

/**
 * Build the publish/finish pair for one trace. `publish` mirrors a copy out of
 * the mutable local trace; `finish` closes it once, freezes the total timing,
 * appends it to the completed runs, and resets the UI/idle state.
 */
export function createTracePublisher(
  deps: PipelineDeps,
  traceLocal: Trace,
  liveUsage: Partial<ContextUsage> = {},
): TracePublisher {
  let closed = false
  const publish = () => {
    const copy: Trace = {
      ...traceLocal,
      timings: { ...traceLocal.timings },
    }
    deps.setTrace(copy)
    deps.traceRef.current = copy
  }
  const finish = (status: RunStatus) => {
    if (closed) return
    closed = true
    traceLocal.status = status
    traceLocal.timings.total = Number(
      (
        traceLocal.timings.route +
        traceLocal.timings.generate +
        traceLocal.timings.critic +
        traceLocal.timings.execute +
        (traceLocal.timings.chat ?? 0)
      ).toFixed(1),
    )
    // Output tokens are the sum the model servers reported across every
    // recorded exchange (chat, retries, worker attempts) — measured, not
    // estimated. A turn with no reported usage keeps whatever the flow set.
    const reported = (traceLocal.exchanges ?? []).reduce(
      (sum, exchange) => sum + (exchange.response?.outputTokens ?? 0),
      0,
    )
    if (reported > 0) traceLocal.outputTokens = reported
    // The packet-decode worker (audio/omni modes) reports its own prompt size.
    if (liveUsage.worker === undefined) {
      const workerExchange = [...(traceLocal.exchanges ?? [])]
        .reverse()
        .find((exchange) => exchange.role === 'worker' && exchange.response?.promptTokens)
      if (workerExchange?.response) liveUsage.worker = workerExchange.response.promptTokens
    }
    // Context budget: apply the prompt sizes the servers measured this turn.
    if (Object.keys(liveUsage).length) {
      deps.setContextUsage((previous) => ({ ...previous, ...liveUsage }))
    }
    const finished: Trace = { ...traceLocal, timings: { ...traceLocal.timings } }
    deps.setTrace(finished)
    deps.traceRef.current = finished
    deps.runsRef.current = [finished, ...deps.runsRef.current].slice(0, 24)
    deps.setRuns(deps.runsRef.current)
    deps.setStage('complete')
    deps.setFlowModel(null)
    deps.setBusy(false)
    deps.busyRef.current = false
    if (deps.idleTimerRef.current) window.clearTimeout(deps.idleTimerRef.current)
    deps.idleTimerRef.current = window.setTimeout(() => {
      deps.setStage((current) => (current === 'complete' ? 'idle' : current))
      deps.idleTimerRef.current = null
    }, 1700)
  }
  const recordExchange = (exchange: TurnExchange) => {
    traceLocal.exchanges = [...(traceLocal.exchanges ?? []), exchange]
    publish()
  }
  return { publish, finish, recordExchange, isClosed: () => closed }
}

/** Provenance label for a rejected call's trace record. */
export type RejectedFlowLabel = 'audio-first pipeline' | 'worker-chat run mode'

/** Rejected-trace record for a worker-authored call the harness refused. */
export function recordRejectedCall(
  deps: PipelineDeps,
  ctx: TurnContext,
  directive: Directive,
  call: WorkerCall,
  reason: string,
  pCorrect: Probability,
  flowLabel: RejectedFlowLabel,
): void {
  deps.setRejectedTraces((previous) => [
    ...previous,
    {
      at: Date.now(),
      command: ctx.command,
      route: { tool: call.name, provenance: flowLabel },
      grounding: { source: 'worker-self' },
      workerXml: call.xml,
      critic: { verdict: 'rejected', reason, pCorrect },
      directive,
    },
  ])
}
