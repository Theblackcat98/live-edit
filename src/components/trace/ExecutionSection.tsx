import { Check, X } from 'lucide-react'
import type { Trace } from '../../types'
import { cx } from '../../lib/utils'
import { TraceSection } from './TraceSection'

/** What the engine wrote: the atomic line diff and the snapshot it left. */
export function ExecutionSection({ execution }: { execution: Trace['execution'] }) {
  return (
    <TraceSection index="E" title="Execution & snapshot" caption="atomic line diff">
      {execution ? (
        <div className="trace-execution">
          <div className="trace-execution-head">
            <span className={cx('trace-execution-icon', execution.ok ? 'is-ok' : 'is-fail')}>
              {execution.ok ? <Check size={12} /> : <X size={12} />}
            </span>
            <p>{execution.message}</p>
          </div>
          {execution.diff && (
            <div className="trace-diff">
              <div className="trace-diff-meta mono">
                <span>start line {execution.diff.startLine}</span>
                <span className="trace-diff-added">+{execution.diff.added}</span>
                <span className="trace-diff-removed">−{execution.diff.removed}</span>
              </div>
              <div className="trace-diff-body">
                {execution.diff.before.map((line, index) => (
                  <div className="trace-diff-line is-before" key={`before-${index}`}>
                    <span className="mono">−</span>
                    <code className="mono">{line || ' '}</code>
                  </div>
                ))}
                {execution.diff.after.map((line, index) => (
                  <div className="trace-diff-line is-after" key={`after-${index}`}>
                    <span className="mono">+</span>
                    <code className="mono">{line || ' '}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="trace-execution-meta mono">
            {execution.snapshotId && <span>snapshot {execution.snapshotId.slice(-6)}</span>}
            <span>{execution.durationMs.toFixed(1)} ms engine</span>
          </div>
        </div>
      ) : (
        <p className="trace-muted">No line was written. The note is unchanged.</p>
      )}
    </TraceSection>
  )
}
