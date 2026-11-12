import type { Directive, Trace } from '../../types'
import { TraceSection } from './TraceSection'

/**
 * The typed delegation brief the worker received (design.md §5). In audio
 * mode the harness builds it from the routed task and the verbatim command;
 * in legacy omni the front-door model writes it.
 */
export function DirectiveSection({
  directive,
  chatShort,
  routed,
  repair,
}: {
  directive: Directive
  chatShort: string
  /** True when d1 routed the turn (audio mode): the harness built the brief. */
  routed: boolean
  repair?: Trace['omniRepair']
}) {
  return (
    <TraceSection
      index="D"
      title="Delegation brief"
      caption={routed ? 'harness → worker · built from your command' : `${chatShort} → worker · typed brief`}
    >
      <div className="trace-kv">
        <span className="trace-kv-key">task</span>
        <span className="trace-kv-value">
          <span className="chip chip-accent">{directive.task}</span>
        </span>
        <span className="trace-kv-key">instruction</span>
        <span className="trace-kv-value trace-body">{directive.instruction}</span>
        {directive.verbatim && (
          <>
            <span className="trace-kv-key">verbatim</span>
            <span className="trace-kv-value">
              <code className="trace-code-inline mono">{directive.verbatim}</code>
            </span>
          </>
        )}
        {directive.target && (
          <>
            <span className="trace-kv-key">target</span>
            <span className="trace-kv-value trace-body">
              <span>
                {directive.target.description}
                {directive.target.heading && (
                  <span className="trace-muted"> · under “{directive.target.heading}”</span>
                )}
              </span>
            </span>
          </>
        )}
        {directive.constraints && directive.constraints.length > 0 && (
          <>
            <span className="trace-kv-key">constraints</span>
            <span className="trace-kv-value trace-chip-row">
              {directive.constraints.map((constraint) => (
                <span className="chip chip-ghost" key={constraint}>
                  {constraint}
                </span>
              ))}
            </span>
          </>
        )}
        {repair && (
          <>
            <span className="trace-kv-key">repair</span>
            <span className="trace-kv-value">
              <span className="trace-body">
                The first tool call failed validation and was retried: {repair.error}
              </span>
              <details className="trace-raw">
                <summary>Rejected arguments</summary>
                <pre className="mono">{repair.rawArguments}</pre>
              </details>
            </span>
          </>
        )}
      </div>
    </TraceSection>
  )
}
