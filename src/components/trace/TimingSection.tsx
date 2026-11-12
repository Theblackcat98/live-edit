import type { Trace } from '../../types'
import { measuredOutputTokens } from '../../lib/runView'
import { TraceSection } from './TraceSection'

type Stage = { key: string; label: string; ms: number; tone: string }

/**
 * Per-stage wall-clock as a proportional strip plus exact values. Every
 * bucket that feeds the total is listed — including the chat reply — so the
 * parts visibly add up to the end-to-end figure. Colours follow the model
 * that owned the stage (interface, d1, worker) and grey for the engine.
 */
export function TimingSection({ trace, chatShort }: { trace: Trace; chatShort: string }) {
  const t = trace.timings
  const stages: Stage[] = [
    { key: 'asr', label: 'Transcription', ms: t.asr ?? 0, tone: 'green' },
    { key: 'chat', label: `${chatShort} reply`, ms: t.chat ?? 0, tone: 'green' },
    { key: 'route', label: 'Routing', ms: t.route, tone: 'accent' },
    { key: 'generate', label: 'Worker', ms: t.generate, tone: 'orange' },
    { key: 'critic', label: 'Safety check', ms: t.critic, tone: 'accent' },
    { key: 'execute', label: 'Apply', ms: t.execute, tone: 'neutral' },
  ]
  const ran = stages.filter((stage) => stage.ms > 0)
  const tokens = measuredOutputTokens(trace)
  const fmt = (ms: number) => (ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`)

  return (
    <TraceSection
      index="T"
      title="Timing"
      caption={t.total ? `${fmt(t.total)} end-to-end` : 'not measured'}
    >
      {ran.length > 0 ? (
        <>
          <div className="trace-timeline" aria-hidden="true">
            {ran.map((stage) => (
              <span
                key={stage.key}
                className={`trace-timeline-segment tone-${stage.tone}`}
                style={{ flexGrow: stage.ms }}
                title={`${stage.label}: ${fmt(stage.ms)}`}
              />
            ))}
          </div>
          <div className="trace-timings">
            {ran.map((stage) => (
              <div key={stage.key} className="trace-timing">
                <span className={`trace-timing-swatch tone-${stage.tone}`} />
                <span className="trace-timing-label">{stage.label}</span>
                <span className="trace-timing-value mono">{fmt(stage.ms)}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="trace-muted">No stage recorded a duration.</p>
      )}
      {tokens.tokens > 0 && (
        <p className="trace-footnote">
          {tokens.measured
            ? `${tokens.tokens} output tokens, as reported by the model servers.`
            : `≈${tokens.tokens} output tokens — not reported by a server.`}
        </p>
      )}
    </TraceSection>
  )
}
