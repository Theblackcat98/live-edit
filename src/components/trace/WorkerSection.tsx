import { useState } from 'react'
import { Braces, Clipboard, Sparkles } from 'lucide-react'
import type { Trace } from '../../types'
import { cx, pad } from '../../lib/utils'
import { TraceSection } from './TraceSection'

function XmlView({ xml }: { xml: string }) {
  const lines = xml.split('\n')
  return (
    <div className="trace-xml">
      {lines.map((line, index) => {
        const trimmed = line.trim()
        const isTag = trimmed.startsWith('<')
        const isParameter = trimmed.startsWith('<parameter=')
        return (
          <div className="trace-xml-line" key={index}>
            <span className="trace-xml-number mono">{pad(index + 1)}</span>
            <span
              className={cx(
                'trace-xml-code mono',
                isTag && 'is-tag',
                isParameter && 'is-parameter',
              )}
            >
              {line || ' '}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The worker call as generated: sampler chips, the model's thought, prompt
 * hints, the raw XML, and the line-numbered note view on demand.
 */
export function WorkerSection({ trace }: { trace: Trace }) {
  const [showNoteView, setShowNoteView] = useState(false)
  return (
    <TraceSection
      index="W"
      title="Worker generation"
      caption={
        !trace.call
          ? 'not run'
          : trace.runtime?.worker === 'dictation'
            ? 'dictated text · harness-built call, no decode'
            : 'LFM3-1.7B · live decode'
      }
    >
      {trace.call ? (
        <div className="trace-worker">
          <div className="trace-param-chips">
            {/* Only what the request actually carried. The bridge sends
                temperature and max_tokens; top_k / repetition_penalty
                were displayed but never sent (audit TD-05). */}
            {trace.call.sampler ? (
              <>
                <span className="chip chip-ghost">temp {trace.call.sampler.temperature}</span>
                <span className="chip chip-ghost">
                  max_tokens {trace.call.sampler.maxTokens ?? 'uncapped'}
                </span>
              </>
            ) : trace.runtime?.worker === 'live' ? (
              // A live decode from before samplers were recorded on the
              // call — the attempt params exist but were not persisted.
              <span className="chip chip-ghost">sampler not recorded</span>
            ) : (
              <span className="chip chip-ghost">no decode · no sampler</span>
            )}
            <span className="chip chip-ghost">
              {trace.call.toolSchemasInjected} tool schema{trace.call.toolSchemasInjected === 1 ? '' : 's'}
            </span>
            {trace.call.rawTokens > 0 && <span className="chip chip-ghost">{trace.call.rawTokens} out tok</span>}
          </div>
          {trace.call.thought && (
            <div className="trace-thought">
              <span className="trace-thought-label">
                <Sparkles size={11} />
                Reasoning
              </span>
              <p>{trace.call.thought}</p>
            </div>
          )}
          {trace.call.promptHints.length > 0 && (
            <ul className="trace-hints">
              {trace.call.promptHints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          )}
          <div className="trace-xml-wrap">
            <div className="trace-xml-head">
              <span>
                <Braces size={11} /> Tool call XML
              </span>
              <span className="mono">{trace.call.xml.split('\n').length} lines</span>
            </div>
            <XmlView xml={trace.call.xml} />
          </div>
          <button
            type="button"
            className="trace-note-toggle mono"
            onClick={() => setShowNoteView((previous) => !previous)}
          >
            <Clipboard size={11} />
            {showNoteView ? 'Hide' : 'Show'} the note as the worker saw it
          </button>
          {showNoteView && <pre className="trace-note-view mono">{trace.workerNoteView}</pre>}
        </div>
      ) : (
        <p className="trace-muted">
          {trace.d1Route && !trace.d1Route.routesToWorker
            ? 'd1 did not route this turn to the worker (see Routing), so it did not run.'
            : trace.status === 'conversational' || trace.status === 'clarify'
              ? 'No edit was requested, so the worker did not run.'
              : 'No worker call — the run stopped before generation.'}
        </p>
      )}
    </TraceSection>
  )
}
