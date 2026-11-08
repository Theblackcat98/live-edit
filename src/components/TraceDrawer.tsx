import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Braces,
  Check,
  CheckCheck,
  Clipboard,
  Copy,
  Gauge,
  Image,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import type { CriticCheck, Trace } from '../types'
import { TOOL_DEFS } from '../data/tools'
import { cx, pad, truncate } from '../lib/utils'
import { SceneCrop } from './SceneCrop'

interface TraceDrawerProps {
  open: boolean
  trace: Trace | null
  runs: Trace[]
  onSelectRun: (id: string) => void
  onClose: () => void
}

function clockOf(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function statusLabel(trace: Trace): string {
  if (trace.status === 'running') return 'running'
  if (trace.status === 'clarify') return 'clarify'
  if (trace.status === 'rejected') return 'held'
  if (trace.status === 'failed') return 'failed'
  if (trace.status === 'conversational') return 'conversational'
  return 'verified'
}

function statusTone(trace: Trace): string {
  if (trace.status === 'verified') return 'chip-green'
  if (trace.status === 'clarify') return 'chip-orange'
  if (trace.status === 'rejected' || trace.status === 'failed') return 'chip-red'
  return 'chip-accent'
}

function Meter({
  value,
  tone = 'accent',
}: {
  value: number
  tone?: 'accent' | 'green' | 'orange' | 'red'
}) {
  return (
    <span className={cx('trace-meter', `tone-${tone}`)} aria-hidden="true">
      <span style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </span>
  )
}

function TraceSection({
  index,
  title,
  caption,
  children,
}: {
  index: string
  title: string
  caption: string
  children: ReactNode
}) {
  return (
    <section className="trace-section">
      <header className="trace-section-head">
        <span className="trace-section-index mono">{index}</span>
        <h3>{title}</h3>
        <span className="trace-section-caption mono">{caption}</span>
      </header>
      <div className="trace-section-body">{children}</div>
    </section>
  )
}

function CheckRow({ check }: { check: CriticCheck }) {
  return (
    <div className={cx('trace-check', check.pass ? 'is-pass' : 'is-fail')}>
      <span className="trace-check-icon">
        {check.pass ? <Check size={10} /> : <X size={10} />}
      </span>
      <span className="trace-check-label mono">{check.label}</span>
      <span className="trace-check-detail">{check.detail ?? ''}</span>
    </div>
  )
}

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

export function TraceDrawer({ open, trace, runs, onSelectRun, onClose }: TraceDrawerProps) {
  const [copied, setCopied] = useState(false)
  const [showNoteView, setShowNoteView] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  useEffect(() => {
    setCopied(false)
    setShowNoteView(false)
  }, [trace?.id, open])

  const summary = useMemo(() => {
    if (!trace) return null
    return {
      runId: trace.id,
      command: trace.command,
      source: trace.source,
      at: new Date(trace.at).toISOString(),
      action: trace.route?.action,
      tool: trace.call?.name,
      span: trace.span,
      bbox: trace.bbox,
      critic: trace.critic
        ? {
            verdict: trace.critic.verdict,
            pCorrect: trace.critic.pCorrect,
            pSafe: trace.critic.pSafe,
            checks: trace.critic.checks,
          }
        : undefined,
      execution: trace.execution
        ? {
            ok: trace.execution.ok,
            message: trace.execution.message,
            snapshotId: trace.execution.snapshotId,
          }
        : undefined,
      timings: trace.timings,
    }
  }, [trace])

  const failedCheck = trace?.critic?.checks.find((check) => !check.pass)

  if (!open) return null

  const copyTrace = async () => {
    if (!summary) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(summary, null, 2))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard access can be blocked outside a user gesture; the view stays intact.
    }
  }

  const content = (
    <div className="trace-overlay">
      <div className="trace-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="trace-drawer" role="dialog" aria-modal="true" aria-label="Decision trace">
        <header className="trace-header">
          <div className="trace-header-main">
            <div className="trace-eyebrow">
              <Braces size={12} />
              <span className="mono">Decision trace</span>
              {trace && <span className={cx('chip', statusTone(trace))}>{statusLabel(trace)}</span>}
            </div>
            <div className="trace-title-row">
              <h2>{trace ? truncate(trace.command, 72) : 'No run selected'}</h2>
              <div className="trace-header-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={copyTrace}
                  disabled={!trace}
                  aria-label="Copy trace JSON"
                  title="Copy trace JSON"
                >
                  {copied ? <CheckCheck size={14} /> : <Copy size={14} />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={onClose}
                  aria-label="Close decision trace"
                  title="Close"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            {trace && (
              <div className="trace-subline mono">
                <span>#{trace.id.slice(-7).toUpperCase()}</span>
                <span>{clockOf(trace.at)}</span>
                <span>{trace.source}</span>
                <span>note {trace.noteTokensAtStart} tok</span>
              </div>
            )}
          </div>
        </header>

        {!trace ? (
          <div className="trace-empty">
            <div className="trace-empty-icon">
              <ScanSearch size={20} />
            </div>
            <h3>No grounded run yet</h3>
            <p>
              Ask Omni to change the note. d1 will register a routing pass, a span, the worker
              XML and the critic verdict here.
            </p>
          </div>
        ) : (
          <div className="trace-scroll">
            {runs.length > 1 && (
              <div className="trace-run-strip" role="tablist" aria-label="Run history">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    role="tab"
                    aria-selected={run.id === trace.id}
                    className={cx('trace-run-chip mono', run.id === trace.id && 'is-active')}
                    onClick={() => onSelectRun(run.id)}
                    title={`${clockOf(run.at)} · ${run.status}`}
                  >
                    <span>#{run.id.slice(-4).toUpperCase()}</span>
                    <span className={cx('trace-run-status', `st-${run.status}`)}>{run.status}</span>
                    <span className="trace-run-clock">{clockOf(run.at)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="trace-summary-grid">
              <div className="trace-summary-cell">
                <span className="mono">action</span>
                <strong>{trace.route?.action?.replace(/_/g, ' ') ?? 'pending'}</strong>
              </div>
              <div className="trace-summary-cell">
                <span className="mono">tool</span>
                <strong>{trace.call?.name ?? '—'}</strong>
              </div>
              <div className="trace-summary-cell">
                <span className="mono">critic</span>
                <strong>
                  {trace.critic ? `P ${trace.critic.pCorrect.toFixed(2)}` : '—'}
                </strong>
              </div>
              <div className="trace-summary-cell">
                <span className="mono">total</span>
                <strong>{trace.timings.total ? `${Math.round(trace.timings.total)} ms` : '—'}</strong>
              </div>
            </div>

            {trace.critic?.verdict === 'rejected' && (
              <div className="trace-verdict">
                <span className="trace-verdict-icon" aria-hidden="true">
                  <X size={11} />
                </span>
                <div>
                  <strong>Held before execution</strong>
                  <p>
                    {failedCheck
                      ? `${failedCheck.label}: ${failedCheck.detail}`
                      : trace.critic.feedback}
                  </p>
                  <span className="trace-verdict-meta mono">
                    P(correct) {trace.critic.pCorrect.toFixed(2)} · P(safe){' '}
                    {trace.critic.pSafe.toFixed(2)} · note untouched
                  </span>
                </div>
              </div>
            )}

            <TraceSection
              index="A"
              title="Pre-flight routing"
              caption={trace.runtime?.route === 'live' ? 'd1-Omni · /v1/systemone' : 'local heuristics'}
            >
              {trace.route ? (
                <div className="trace-route">
                  <div className="trace-query-row">
                    <div className="trace-query-name mono">action_required</div>
                    <div className="trace-query-value">
                      <span className={cx('chip', trace.route.action === 'file_mutation' ? 'chip-accent' : trace.route.action === 'ambiguous_request' ? 'chip-orange' : 'chip-green')}>
                        {trace.route.action.replace(/_/g, ' ')}
                      </span>
                      <span className="trace-query-p mono">
                        P {trace.route.actionConfidence.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div className="trace-query-row">
                    <div className="trace-query-name mono">allowed_tools</div>
                    <div className="trace-tool-list">
                      {trace.route.allowedTools.length === 0 && (
                        <span className="trace-muted">none — conversation short-circuit</span>
                      )}
                      {trace.route.allowedTools.map((tool) => (
                        <div
                          className={cx('trace-tool-score', tool.p <= 0.25 && 'is-pruned')}
                          key={tool.name}
                        >
                          <span className="mono">{tool.name}</span>
                          <Meter value={tool.p} tone={tool.p > 0.25 ? 'accent' : 'orange'} />
                          <span className="mono">{tool.p.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <p className="trace-reason">{trace.route.reason}</p>
                  <div className="trace-hint-row mono">
                    <span>
                      {trace.route.allowedTools.filter((tool) => tool.p > 0.25).length} schema
                      {trace.route.allowedTools.filter((tool) => tool.p > 0.25).length === 1 ? '' : 's'}{' '}
                      injected
                    </span>
                    <span>
                      {TOOL_DEFS.length -
                        trace.route.allowedTools.filter((tool) => tool.p > 0.25).length}{' '}
                      withheld
                    </span>
                    {trace.route.directive && <span>directive: {trace.route.directive}</span>}
                  </div>
                </div>
              ) : (
                <p className="trace-muted">Routing pass pending.</p>
              )}
            </TraceSection>

            <TraceSection index="B" title="Zero-token grounding" caption="deterministic span search">
              {trace.span || trace.bbox ? (
                <div className="trace-grounding">
                  {trace.span && (
                    <div className="trace-span-card">
                      <div className="trace-span-head">
                        <span className="chip chip-accent mono">
                          L{trace.span.startLine}
                          {trace.span.endLine !== trace.span.startLine ? `–${trace.span.endLine}` : ''}
                        </span>
                        <span className="mono">P {trace.span.confidence.toFixed(2)}</span>
                        <span className="trace-span-label">target span</span>
                      </div>
                      <div className="trace-span-lines">
                        {trace.span.excerpt.split('\n').map((line, index) => (
                          <div className="trace-span-line" key={index}>
                            <span className="mono">{trace.span!.startLine + index}</span>
                            <code className="mono">{line || ' '}</code>
                          </div>
                        ))}
                      </div>
                      <p className="trace-reason">{trace.span.reason}</p>
                    </div>
                  )}
                  {trace.bbox && (
                    <div className="trace-bbox-card">
                      <div className="trace-bbox-preview">
                        <SceneCrop region={trace.bbox.region} />
                      </div>
                      <div className="trace-bbox-meta">
                        <div className="trace-bbox-title">
                          <Image size={11} />
                          ROI crop
                        </div>
                        <div className="mono">{trace.bbox.label}</div>
                        <div className="trace-bbox-conf mono">
                          P {trace.bbox.confidence.toFixed(2)} · {trace.bbox.source}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="trace-muted">Grounding was skipped for this turn.</p>
              )}
            </TraceSection>

            <TraceSection
              index="W"
              title="Worker generation"
              caption={trace.runtime?.worker === 'live' ? 'LFM3-VL-2B · live decode' : 'template fallback'}
            >
              {trace.call ? (
                <div className="trace-worker">
                  <div className="trace-param-chips">
                    <span className="chip chip-ghost mono">temp 0.1</span>
                    <span className="chip chip-ghost mono">top_k 50</span>
                    <span className="chip chip-ghost mono">rep 1.1</span>
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
                  No worker call.
                  {trace.route?.action === 'conversational_only'
                    ? ' The turn stayed conversational — no file mutation.'
                    : ' The run stopped before generation.'}
                </p>
              )}
            </TraceSection>

            <TraceSection
              index="C"
              title="Post-generation critic"
              caption={trace.runtime?.critic === 'live' ? 'd1 pass + local gates' : 'local gates only'}
            >
              {trace.critic ? (
                <div className="trace-critic">
                  <div className="trace-critic-meters">
                    <div className="trace-critic-meter">
                      <div className="trace-critic-meter-head">
                        <span className="mono">P(correct_tool_call)</span>
                        <strong className="mono">{trace.critic.pCorrect.toFixed(2)}</strong>
                      </div>
                      <Meter value={trace.critic.pCorrect} tone="accent" />
                    </div>
                    <div className="trace-critic-meter">
                      <div className="trace-critic-meter-head">
                        <span className="mono">P(destructive_safe)</span>
                        <strong className="mono">{trace.critic.pSafe.toFixed(2)}</strong>
                      </div>
                      <Meter value={trace.critic.pSafe} tone="green" />
                    </div>
                  </div>
                  <div className="trace-checks">
                    {trace.critic.checks.map((check) => (
                      <CheckRow key={check.label} check={check} />
                    ))}
                  </div>
                  {trace.critic.feedback && (
                    <div className="trace-feedback mono">{trace.critic.feedback}</div>
                  )}
                </div>
              ) : (
                <p className="trace-muted">Critic pass pending.</p>
              )}
            </TraceSection>

            <TraceSection index="E" title="Execution & snapshot" caption="atomic line diff">
              {trace.execution ? (
                <div className="trace-execution">
                  <div className="trace-execution-head">
                    <span
                      className={cx(
                        'trace-execution-icon',
                        trace.execution.ok ? 'is-ok' : 'is-fail',
                      )}
                    >
                      {trace.execution.ok ? <Check size={12} /> : <X size={12} />}
                    </span>
                    <p>{trace.execution.message}</p>
                  </div>
                  {trace.execution.diff && (
                    <div className="trace-diff">
                      <div className="trace-diff-meta mono">
                        <span>start line {trace.execution.diff.startLine}</span>
                        <span className="trace-diff-added">+{trace.execution.diff.added}</span>
                        <span className="trace-diff-removed">−{trace.execution.diff.removed}</span>
                      </div>
                      <div className="trace-diff-body">
                        {trace.execution.diff.before.map((line, index) => (
                          <div className="trace-diff-line is-before" key={`before-${index}`}>
                            <span className="mono">−</span>
                            <code className="mono">{line || ' '}</code>
                          </div>
                        ))}
                        {trace.execution.diff.after.map((line, index) => (
                          <div className="trace-diff-line is-after" key={`after-${index}`}>
                            <span className="mono">+</span>
                            <code className="mono">{line || ' '}</code>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="trace-execution-meta mono">
                    {trace.execution.snapshotId && <span>snapshot {trace.execution.snapshotId.slice(-6)}</span>}
                    <span>{trace.execution.durationMs.toFixed(1)} ms engine</span>
                  </div>
                </div>
              ) : (
                <p className="trace-muted">No line was written. The note is unchanged.</p>
              )}
            </TraceSection>

            <TraceSection index="T" title="Timing" caption="measured runtime">
              <div className="trace-timeline">
                {(
                  [
                    ['route', trace.timings.route, 'accent'],
                    ['ground', trace.timings.ground, 'accent'],
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
                    ['ground', trace.timings.ground],
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
                {trace.outputTokens} output tokens
              </div>
            </TraceSection>

            <div className="trace-footer">
              <ShieldCheck size={11} />
              <span className="mono">
                Engine in-tab · models on 127.0.0.1 · fallbacks labeled per stage
              </span>
            </div>
          </div>
        )}
      </aside>
    </div>
  )

  return createPortal(content, document.body)
}
