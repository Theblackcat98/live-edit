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
}: {
  trace: Trace | null
  stageStates: Record<StageId, StageState>
  openTrace: () => void
}) {
  const running = Object.values(stageStates).some((state) => state === 'running')

  return (
    <section className="rail-card supervisor-card">
      <header className="rail-header">
        <div className="rail-title">
          <ScanSearch size={13} />
          Safety check
          <span className={cx('status-dot', running ? 'is-accent is-pulsing' : 'is-accent')} />
        </div>
        <span
          className="chip chip-ghost mono"
          title={
            trace && (trace.runtime?.worker === 'live' || trace.runtime?.chat === 'live')
              ? 'token usage reported by the model server'
              : 'estimated from local text — no model decode reported usage'
          }
        >
          {trace?.outputTokens
            ? `${
                trace.runtime?.worker === 'live' || trace.runtime?.chat === 'live' ? '' : '≈'
              }${trace.outputTokens} output tokens`
            : '0 output tokens'}
        </span>
      </header>
      <div className="supervisor-model mono">d1-Omni-2B · 128K · Q8_0 · single pass</div>

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
          ) : (
            <span className="sup-muted">Local hard gates · d1 safety check</span>
          )}
        </Stage>
      </div>

      <button
        type="button"
        className="supervisor-trace-button"
        onClick={openTrace}
        disabled={!trace}
      >
        Open decision trace
        <ArrowUpRight size={11} />
      </button>
    </section>
  )
}
