import type { ReactNode } from 'react'
import {
  ArrowUpRight,
  Check,
  Circle,
  LoaderCircle,
  Minus,
  ScanSearch,
  X,
} from 'lucide-react'
import type { StageId, StageState, Trace } from '../../types'
import { cx } from '../../lib/utils'
import { modeDef } from '../../lib/modes'
import type { RunMode } from '../../lib/runmode'
import { measuredOutputTokens } from '../../lib/runView'
import { D1_CHECK } from '../../data/models'

function formatTiming(value: number | undefined): string {
  if (!value) return '—'
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
}

function toggleClass(state: StageState): string {
  return `is-${state}`
}

function StageIcon({ state }: { state: StageState }) {
  if (state === 'running') return <LoaderCircle size={11} className="spin" />
  if (state === 'done') return <Check size={11} />
  if (state === 'skipped') return <Minus size={11} />
  if (state === 'failed') return <X size={11} />
  return <Circle size={7} />
}

function Stage({
  letter,
  title,
  state,
  timing,
  children,
  last,
}: {
  letter: StageId
  title: string
  state: StageState
  timing?: number
  children: ReactNode
  last?: boolean
}) {
  return (
    <div className={cx('sup-stage', toggleClass(state), last && 'is-last')}>
      <div className="sup-stage-track">
        <span className="sup-stage-node">
          <span className="sup-stage-letter mono">{letter}</span>
          <span className="sup-stage-state">
            <StageIcon state={state} />
          </span>
        </span>
        {!last && <span className="sup-stage-line" />}
      </div>
      <div className="sup-stage-main">
        <div className="sup-stage-head">
          <span className="sup-stage-title mono">{title}</span>
          <span className="sup-stage-time mono">{formatTiming(timing)}</span>
        </div>
        <div className="sup-stage-body">{children}</div>
      </div>
    </div>
  )
}

/** Route → ground → verify, as far as this turn actually got. */
export function SafetyCheckCard({
  trace,
  stageStates,
  openTrace,
  mode,
  canOpenTrace,
}: {
  trace: Trace | null
  stageStates: Record<StageId, StageState>
  openTrace: () => void
  mode: RunMode
  /** True when any run (current or persisted) can be inspected. */
  canOpenTrace: boolean
}) {
  const running = Object.values(stageStates).some((state) => state === 'running')
  const def = modeDef(mode)
  const hasD1 = def.decide === 'd1'
  const tokens = trace ? measuredOutputTokens(trace) : null
  // What routed the turn, in this mode's terms.
  const routeDone = (() => {
    if (!trace) return 'Awaiting a command'
    if (trace.d1Route) {
      const conf = trace.d1Route.confidence === null ? 'unreported' : trace.d1Route.confidence.toFixed(2)
      return `d1: ${trace.d1Route.intent} · confidence ${conf}`
    }
    if (trace.directive) return `${def.chat.short} delegated a ${trace.directive.task} brief`
    return 'Routed'
  })()

  return (
    <section className="rail-card supervisor-card">
      <header className="rail-header">
        <div className="rail-title">
          <ScanSearch size={13} />
          Safety check
          <span className={cx('status-dot', running ? 'is-accent is-pulsing' : 'is-accent')} />
        </div>
        {tokens && tokens.tokens > 0 && (
          <span
            className="chip chip-ghost mono"
            title={
              tokens.measured
                ? 'Output tokens the model servers reported for this turn'
                : 'No server reported usage for this turn — figure not measured'
            }
          >
            {tokens.measured ? '' : '≈'}
            {tokens.tokens} out tok
          </span>
        )}
      </header>
      <div className="supervisor-model mono">
        {hasD1
          ? `${D1_CHECK.name} · ${D1_CHECK.contextK}K · ${D1_CHECK.quant} · zero-output-token verdict`
          : 'No d1 in this mode — hard gates run, then every edit is held for you'}
      </div>

      {/* What the safety check saw and decided, straight from the trace.
          These fields were recorded but never surfaced on the rail. */}
      {trace?.directive && (
        <div className="supervisor-model mono">brief · {trace.directive.task}</div>
      )}
      {trace?.d1Check && (
        <div className="supervisor-model mono">
          safety {trace.d1Check.verdict}
          {trace.d1Check.noul === null ? '' : ` · match ${trace.d1Check.noul.toFixed(2)}`}
          {` · ${trace.d1Check.destructiveSafety ?? 'unreported'}`}
        </div>
      )}
      {trace?.hold && (
        <div className="supervisor-model mono">held · {trace.hold.reason}</div>
      )}

      <div className="sup-stages">
        <Stage
          letter="A"
          title="ROUTE"
          state={stageStates.A}
          timing={trace?.timings.route}
        >
          {stageStates.A === 'running' ? (
            <span className="sup-running">Reading the command…</span>
          ) : stageStates.A === 'skipped' ? (
            <span className="sup-muted">No routing pass for this turn.</span>
          ) : stageStates.A === 'done' ? (
            <span className="sup-muted">{routeDone}</span>
          ) : (
            <span className="sup-muted">Awaiting a command</span>
          )}
        </Stage>

        <Stage
          letter="B"
          title="GROUND"
          state={stageStates.B}
        >
          {stageStates.B === 'running' ? (
            <span className="sup-running">Worker is grounding the span…</span>
          ) : stageStates.B === 'skipped' ? (
            <span className="sup-muted">No edit this turn.</span>
          ) : stageStates.B === 'done' && trace?.call ? (
            <span className="sup-muted">
              {trace.runtime?.worker === 'dictation'
                ? `Dictated text · ${trace.call.name}`
                : `1.7B wrote ${trace.call.name}`}
            </span>
          ) : (
            <span className="sup-muted">The worker grounds its own span</span>
          )}
        </Stage>

        <Stage
          letter="C"
          title="VERIFY"
          state={stageStates.C}
          timing={trace?.timings.critic}
          last
        >
          {stageStates.C === 'running' ? (
            <span className="sup-running">Running the safety check…</span>
          ) : stageStates.C === 'skipped' ? (
            <span className="sup-muted">No worker call to check.</span>
          ) : stageStates.C === 'done' && trace?.d1Check ? (
            <span className="sup-muted">d1 {trace.d1Check.verdict}</span>
          ) : (
            <span className="sup-muted">
              {hasD1 ? 'Hard gates · d1 safety check' : 'Hard gates · held for your decision'}
            </span>
          )}
        </Stage>
      </div>

      <button
        type="button"
        className="supervisor-trace-button"
        onClick={openTrace}
        disabled={!canOpenTrace}
      >
        Open decision trace
        <ArrowUpRight size={11} />
      </button>
    </section>
  )
}
