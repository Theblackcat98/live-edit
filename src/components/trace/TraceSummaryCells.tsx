import type { Trace } from '../../types'

/** The three headline cells at the top of the decision tab. */
export function TraceSummaryCells({ trace }: { trace: Trace }) {
  return (
    <div className="trace-summary-grid">
      <div className="trace-summary-cell">
        <span className="mono">tool</span>
        <strong>{trace.call?.name ?? '—'}</strong>
      </div>
      <div className="trace-summary-cell">
        <span className="mono">d1 check</span>
        <strong>{trace.d1Check?.verdict ?? '—'}</strong>
      </div>
      <div className="trace-summary-cell">
        <span className="mono">total</span>
        <strong>{trace.timings.total ? `${Math.round(trace.timings.total)} ms` : '—'}</strong>
      </div>
    </div>
  )
}
