import { Gauge } from 'lucide-react'
import type { Trace } from '../../types'
import { cx } from '../../lib/utils'
import { TraceSection } from './TraceSection'

/** Per-stage wall-clock, shown as a proportional strip and an exact grid. */
export function TimingSection({ trace }: { trace: Trace }) {
  return (
    <TraceSection index="T" title="Timing" caption="measured runtime">
      <div className="trace-timeline">
        {(
          [
            ['route', trace.timings.route, 'accent'],
            ['generate', trace.timings.generate, 'orange'],
            ['critic', trace.timings.critic, 'accent'],
            ['execute', trace.timings.execute, 'green'],
          ] as const
        ).map(([label, value, tone]) => (
          <span
            key={label}
            className={cx('trace-timeline-segment', `tone-${tone}`)}
            style={{ flexGrow: Math.max(value, 1) }}
            title={`${label}: ${value.toFixed(1)} ms`}
          />
        ))}
      </div>
      <div className="trace-timings-grid">
        {(
          [
            ['route', trace.timings.route],
            ['generate', trace.timings.generate],
            ['critic', trace.timings.critic],
            ['execute', trace.timings.execute],
          ] as const
        ).map(([label, value]) => (
          <span key={label} className="trace-timing">
            <span className="mono">{label}</span>
            <strong className="mono">{value ? `${value.toFixed(1)} ms` : '—'}</strong>
          </span>
        ))}
      </div>
      <div className="trace-total mono">
        <Gauge size={11} />
        end-to-end {trace.timings.total ? `${Math.round(trace.timings.total)} ms` : '—'} ·{' '}
        {trace.runtime?.worker === 'live' || trace.runtime?.chat === 'live' ? '' : '≈'}
        {trace.outputTokens} output tokens
      </div>
    </TraceSection>
  )
}
