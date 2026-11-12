import type { Trace } from '../../types'

/** Headline cells at the top of the decision tab — one per pipeline stage that ran. */
export function TraceSummaryCells({ trace, chatShort }: { trace: Trace; chatShort: string }) {
  const route = trace.d1Route
    ? trace.d1Route.intent
    : trace.directive
      ? `${chatShort} → ${trace.directive.task}`
      : null
  const cells: Array<[string, string]> = [
    ['Routing', route ?? '—'],
    ['Tool', trace.call?.name ?? '—'],
    ['Safety check', trace.d1Check?.verdict ?? '—'],
    ['Total', trace.timings.total ? `${Math.round(trace.timings.total)} ms` : '—'],
  ]
  return (
    <div className="trace-summary-grid">
      {cells.map(([label, value]) => (
        <div className="trace-summary-cell" key={label}>
          <span>{label}</span>
          <strong className="mono">{value}</strong>
        </div>
      ))}
    </div>
  )
}
