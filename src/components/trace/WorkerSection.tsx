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
        trace.runtime?.worker === 'live'
          ? 'LFM3-1.7B · live decode'
          : 'dictation exception · harness-built call'
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
                <span className="chip chip-ghost mono">
                  temp {trace.call.sampler.temperature}
                </span>
                <span className="chip chip-ghost mono">
                  max_tokens {trace.call.sampler.maxTokens ?? '∞'}
                </span>
              </>
            ) : trace.runtime?.worker === 'live' ? (
              // A live decode from before samplers were recorded on the
              // call — the attempt params exist but were not persisted.
              <span className="chip chip-ghost mono">sampler not recorded</span>
            ) : (
              <span className="chip chip-ghost mono">
                dictation exception · no decode, no sampler
              </span>
            )}
            <span className="chip chip-ghost mono">{trace.call.toolSchemasInjected} schema</span>
            <span className="chip chip-ghost mono">{trace.call.rawTokens} out tok</span>
          </div>
          <div className="trace-thought">
            <span className="trace-thought-label mono">
              <Sparkles size={10} />
              &lt;think&gt;
            </span>
            <p>{trace.call.thought}</p>
          </div>
          <div className="trace-hints">
            {trace.call.promptHints.map((hint) => (
              <div key={hint} className="trace-hint">
                <span className="trace-hint-dot" />
                <span className="mono">{hint}</span>
              </div>
            ))}
          </div>
          <div className="trace-xml-wrap">
            <div className="trace-xml-head">
              <span className="mono">
                <Braces size={10} /> tool call XML
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
            <Clipboard size={10} />
            {showNoteView ? 'Hide' : 'Show'} line-numbered worker view
          </button>
          {showNoteView && <pre className="trace-note-view mono">{trace.workerNoteView}</pre>}
        </div>
      ) : (
        <p className="trace-muted">
          No worker call. The run stopped before generation.
        </p>
      )}
    </TraceSection>
  )
}
