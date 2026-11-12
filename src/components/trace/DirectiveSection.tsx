import type { Directive } from '../../types'
import { TraceSection } from './TraceSection'

/**
 * Audio's typed delegation directive (design.md §5), recorded on the trace
 * from P2 on. Legacy supervisor-first traces have no directive field — for
 * them this section simply does not render.
 */
export function DirectiveSection({
  directive,
  chatShort,
}: {
  directive: Directive
  chatShort: string
}) {
  return (
    <TraceSection index="D" title="Delegation directive" caption={`${chatShort} → worker · typed brief`}>
      <div className="trace-route">
        <div className="trace-query-row">
          <div className="trace-query-name mono">task</div>
          <div className="trace-query-value">
            <span className="chip chip-accent mono">{directive.task}</span>
          </div>
        </div>
        <div className="trace-query-row">
          <div className="trace-query-name mono">instruction</div>
          <div className="trace-query-value">
            <div className="trace-tool-list">
              <p className="trace-reason">{directive.instruction}</p>
            </div>
          </div>
        </div>
        {directive.verbatim && (
          // The one case where content legitimately travels inside the
          // directive: the user dictated exact words (§5).
          <div className="trace-query-row">
            <div className="trace-query-name mono">verbatim</div>
            <div className="trace-query-value">
              <div className="trace-tool-list">
                <p className="trace-reason mono">{directive.verbatim}</p>
              </div>
            </div>
          </div>
        )}
        {directive.target && (
          <div className="trace-query-row">
            <div className="trace-query-name mono">target</div>
            <div className="trace-query-value">
              <div className="trace-tool-list">
                <p className="trace-reason">{directive.target.description}</p>
                {directive.target.heading && (
                  <p className="trace-muted">under {directive.target.heading}</p>
                )}
              </div>
            </div>
          </div>
        )}
        {directive.constraints && directive.constraints.length > 0 && (
          <div className="trace-query-row">
            <div className="trace-query-name mono">constraints</div>
            <div className="trace-query-value">
              <div className="trace-tool-list">
                {directive.constraints.map((constraint) => (
                  <span className="chip chip-ghost mono" key={constraint}>
                    {constraint}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </TraceSection>
  )
}
