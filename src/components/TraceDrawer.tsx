import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Braces,
  Check,
  CheckCheck,
  Clipboard,
  Copy,
  Gauge,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import type { RejectedTraceRecord, Trace } from '../types'
import { modeDef } from '../lib/modes'
import type { RunMode } from '../lib/runmode'
import { cx, pad, truncate } from '../lib/utils'
import { Download } from 'lucide-react'
import { TraceSummaryCells } from './trace/TraceSummaryCells'
import { D1CheckSection } from './trace/D1CheckSection'
import { HoldSection } from './trace/HoldSection'
import { ExchangeList } from './trace/ExchangeList'
import { TraceSection } from './trace/TraceSection'

interface TraceDrawerProps {
  rejectedTraces: RejectedTraceRecord[]
  open: boolean
  trace: Trace | null
  runs: Trace[]
  /** Active run mode — captions name the model that serves it. */
  mode: RunMode
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
  if (trace.status === 'pending') return 'pending'
  if (trace.status === 'failed') return 'failed'
  if (trace.status === 'conversational') return 'conversational'
  return 'verified'
}

function statusTone(trace: Trace): string {
  if (trace.status === 'verified') return 'chip-green'
  if (trace.status === 'clarify' || trace.status === 'pending') return 'chip-orange'
  if (trace.status === 'rejected' || trace.status === 'failed') return 'chip-red'
  return 'chip-accent'
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

export function TraceDrawer({ open, trace, runs, rejectedTraces, mode, onSelectRun, onClose }: TraceDrawerProps) {
  const chatShort = modeDef(mode).chat.short
  const [tab, setTab] = useState<'decision' | 'chat'>('decision')
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
    // Conversational and failed turns have no decision content — open where
    // the information is. Delegations and executed actions keep the classic view.
    setTab(trace?.call || trace?.execution || !trace?.exchanges?.length ? 'decision' : 'chat')
  }, [trace?.id, open])

  const summary = useMemo(() => {
    if (!trace) return null
    return {
      runId: trace.id,
      command: trace.command,
      source: trace.source,
      at: new Date(trace.at).toISOString(),
      tool: trace.call?.name,
      d1Check: trace.d1Check
        ? {
            verdict: trace.d1Check.verdict,
            noul: trace.d1Check.noul,
            destructiveSafety: trace.d1Check.destructiveSafety,
            reason: trace.d1Check.reason,
            ms: trace.d1Check.ms,
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
      hold: trace.hold,
      exchanges: trace.exchanges ?? [],
    }
  }, [trace])

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

  const downloadRejected = () => {
    if (!rejectedTraces.length) return
    const jsonl = `${rejectedTraces.map((record) => JSON.stringify(record)).join('\n')}\n`
    const blob = new Blob([jsonl], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'liquidscribe-rejected-traces.jsonl'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
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
            <h3>No run yet</h3>
            <p>
              Ask {chatShort} to change the note. Each run registers the
              delegation directive, the worker XML, the safety-check verdict and the diff here.
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
            <div className="trace-tabs" role="tablist" aria-label="Turn inspection">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'decision'}
                className={cx('trace-tab', tab === 'decision' && 'is-active')}
                onClick={() => setTab('decision')}
              >
                Decision
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'chat'}
                className={cx('trace-tab', tab === 'chat' && 'is-active')}
                onClick={() => setTab('chat')}
              >
                Chat
                {!!trace.exchanges?.length && (
                  <span className="trace-tab-count mono">{trace.exchanges.length}</span>
                )}
              </button>
            </div>
            {tab === 'decision' ? (
              <>
            <TraceSummaryCells trace={trace} />

            {trace.d1Check && <D1CheckSection check={trace.d1Check} />}

            {trace.hold && <HoldSection hold={trace.hold} status={trace.status} />}

            {trace.directive && (
              // Audio's typed delegation directive (design.md §5), recorded on
              // the trace from P2 on. Legacy supervisor-first traces have no
              // directive field — for them this section simply does not
              // render, leaving the drawer exactly as it was.
              <TraceSection index="D" title="Delegation directive" caption={`${chatShort} → worker · typed brief`}>
                <div className="trace-route">
                  <div className="trace-query-row">
                    <div className="trace-query-name mono">task</div>
                    <div className="trace-query-value">
                      <span className="chip chip-accent mono">{trace.directive.task}</span>
                    </div>
                  </div>
                  <div className="trace-query-row">
                    <div className="trace-query-name mono">instruction</div>
                    <div className="trace-query-value">
                      <div className="trace-tool-list">
                        <p className="trace-reason">{trace.directive.instruction}</p>
                      </div>
                    </div>
                  </div>
                  {trace.directive.verbatim && (
                    // The one case where content legitimately travels inside
                    // the directive: the user dictated exact words (§5).
                    <div className="trace-query-row">
                      <div className="trace-query-name mono">verbatim</div>
                      <div className="trace-query-value">
                        <div className="trace-tool-list">
                          <p className="trace-reason mono">{trace.directive.verbatim}</p>
                        </div>
                      </div>
                    </div>
                  )}
                  {trace.directive.target && (
                    <div className="trace-query-row">
                      <div className="trace-query-name mono">target</div>
                      <div className="trace-query-value">
                        <div className="trace-tool-list">
                          <p className="trace-reason">{trace.directive.target.description}</p>
                          {trace.directive.target.heading && (
                            <p className="trace-muted">under {trace.directive.target.heading}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {trace.directive.constraints && trace.directive.constraints.length > 0 && (
                    <div className="trace-query-row">
                      <div className="trace-query-name mono">constraints</div>
                      <div className="trace-query-value">
                        <div className="trace-tool-list">
                          {trace.directive.constraints.map((constraint) => (
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
            )}

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

            <div className="trace-footer">
              <ShieldCheck size={11} />
              <span className="mono">
                Engine in-tab · models on 127.0.0.1 · fallbacks labeled per stage
              </span>
              <button
                type="button"
                className="trace-export-button mono"
                disabled={rejectedTraces.length === 0}
                title={
                  rejectedTraces.length
                    ? `Download ${rejectedTraces.length} rejected trace record${
                        rejectedTraces.length === 1 ? '' : 's'
                      } as JSONL`
                    : 'No rejected traces yet — no worker call or pending edit has been refused this session'
                }
                onClick={downloadRejected}
              >
                <Download size={11} />
                Download rejected · JSONL
              </button>
            </div>
              </>
            ) : (
              <ExchangeList exchanges={trace.exchanges ?? []} />
            )}
          </div>
        )}
      </aside>
    </div>
  )

  return createPortal(content, document.body)
}
