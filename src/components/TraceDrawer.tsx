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
  ScanSearch,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import type { CriticCheck, ExchangeMessage, Probability, RejectedTraceRecord, Trace, TurnExchange, TurnHold } from '../types'
import type { RunMode } from '../lib/runmode'
import { chatModelShort } from '../lib/runmode'
import { TOOL_DEFS } from '../data/tools'
import { cx, formatP, pAdopted, pad, truncate } from '../lib/utils'
import { Download } from 'lucide-react'

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

/** `P 0.87` for a measured score; the word "unreported" for a null one. */
function pLabel(value: Probability | undefined): string {
  return typeof value === 'number' ? `P ${value.toFixed(2)}` : 'unreported'
}

function Meter({
  value,
  tone = 'accent',
}: {
  value: number | null
  tone?: 'accent' | 'green' | 'orange' | 'red'
}) {
  // An unreported score renders as an empty track — never a fabricated fill.
  const width = value === null ? 0 : Math.max(2, Math.min(100, value * 100))
  return (
    <span className={cx('trace-meter', `tone-${tone}`)} aria-hidden="true">
      <span style={{ width: `${width}%` }} />
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

/** Head-line for a turn that stopped or was held before execution (§8/§9). */
const HOLD_TITLES: Record<TurnHold['kind'], string> = {
  'hard-gate': 'Stopped by a hard gate — not overridable',
  'blast-radius': 'Blast-radius limit — held for your decision',
  'blast-collapse': 'Section-scale collapse (§8) — held for your decision',
  'no-decision-model': 'No decision model in this mode — held for your decision',
  engine: 'The engine refused this call',
  outcome: 'Outcome check failed — nothing was written',
  d1: 'Safety check — held for your decision',
}

function ExchangeMessagesView({ messages }: { messages: ExchangeMessage[] }) {
  return (
    <div className="exchange-messages">
      {messages.map((message, index) => (
        <div className="exchange-msg" key={index}>
          <span className={cx('exchange-msg-role mono', `r-${message.role}`)}>{message.role}</span>
          <div className="exchange-msg-body">
            {message.content && <pre className="mono">{message.content}</pre>}
            {message.toolCalls?.map((call, callIndex) => (
              <div className="exchange-msg-call" key={callIndex}>
                <span className="chip chip-accent mono">{call.name}</span>
                <pre className="mono">{call.arguments}</pre>
              </div>
            ))}
            {message.toolCallId && (
              <span className="exchange-msg-tool-id mono">answers {message.toolCallId}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function ExchangeCard({
  exchange,
  index,
  total,
}: {
  exchange: TurnExchange
  index: number
  total: number
}) {
  const [showContext, setShowContext] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setShowContext(false)
    setCopied(false)
  }, [exchange.id])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(exchange, null, 2))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be blocked outside a user gesture; the view stays intact.
    }
  }

  const response = exchange.response
  return (
    <article className={cx('exchange-card', !exchange.ok && 'is-failed')} data-exchange-label={exchange.label}>
      <header className="exchange-head">
        <span className="exchange-index mono">
          {index + 1}/{total}
        </span>
        <span className="chip chip-ghost mono">{exchange.role}</span>
        <strong className="exchange-model">{exchange.model}</strong>
        <span className="exchange-label mono">{exchange.label}</span>
        <span className={cx('chip mono', exchange.ok ? 'chip-green' : 'chip-red')}>
          {exchange.ok ? 'ok' : 'failed'}
        </span>
        <span className="mono">{Math.round(exchange.ms)} ms</span>
        <button
          type="button"
          className="icon-button"
          onClick={copy}
          aria-label="Copy exchange JSON"
          title="Copy exchange JSON"
        >
          {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
        </button>
      </header>
      <div className="exchange-meta mono">
        <span className="exchange-url">{exchange.url}</span>
        <span>temp {exchange.request.temperature}</span>
        <span>max_tokens {exchange.request.maxTokens ?? '∞'}</span>
        <span>{exchange.request.stream ? 'stream' : 'complete'}</span>
        {exchange.request.tools && <span>tools {exchange.request.tools.join(' + ')}</span>}
        {response && (
          <span>
            {response.promptTokens}→{response.outputTokens} tok
          </span>
        )}
        {response?.finishReason && (
          <span className={cx(response.finishReason === 'length' && 'is-truncated')}>
            finish {response.finishReason}
          </span>
        )}
      </div>
      {exchange.error && <div className="exchange-error mono">{exchange.error}</div>}
      {response?.reasoning && (
        <div className="trace-thought">
          <span className="trace-thought-label mono">
            <Sparkles size={10} />
            &lt;think&gt;
          </span>
          <p>{response.reasoning}</p>
        </div>
      )}
      {response?.text && <pre className="exchange-reply mono">{response.text}</pre>}
      {response && response.toolCalls.length > 0 && (
        <div className="exchange-calls">
          {response.toolCalls.map((call, callIndex) => (
            <div className="exchange-call" key={callIndex}>
              <span className="chip chip-accent mono">{call.name}</span>
              <pre className="mono">{call.arguments}</pre>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="trace-note-toggle mono"
        onClick={() => setShowContext((previous) => !previous)}
      >
        <Clipboard size={10} />
        {showContext ? 'Hide' : 'Show'} context sent · {exchange.request.messages.length} messages
      </button>
      {showContext && <ExchangeMessagesView messages={exchange.request.messages} />}
    </article>
  )
}


export function TraceDrawer({ open, trace, runs, rejectedTraces, mode, onSelectRun, onClose }: TraceDrawerProps) {
  const chatShort = chatModelShort(mode)
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
      action: trace.route?.action,
      tool: trace.call?.name,
      critic: trace.critic
        ? {
            verdict: trace.critic.verdict,
            pCorrect: trace.critic.pCorrect,
            pSafe: trace.critic.pSafe,
            checks: trace.critic.checks,
          }
        : undefined,
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
            <h3>No grounded run yet</h3>
            <p>
              Ask {chatShort} to change the note. Each run registers the
              directive, the worker XML, the d1 verdict and the diff here.
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
                <span className="mono">{trace.d1Check ? 'd1 check' : 'critic'}</span>
                <strong>
                  {trace.d1Check
                    ? trace.d1Check.verdict
                    : trace.critic
                      ? pLabel(trace.critic.pCorrect)
                      : '—'}
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
                    P(correct) {formatP(trace.critic.pCorrect)} · P(safe){' '}
                    {formatP(trace.critic.pSafe)} · note untouched
                  </span>
                </div>
              </div>
            )}

            {trace.d1Check && trace.d1Check.verdict !== 'approved' && (
              <div className="trace-verdict">
                <span className="trace-verdict-icon" aria-hidden="true">
                  <X size={11} />
                </span>
                <div>
                  <strong>
                    {trace.d1Check.verdict === 'unavailable'
                      ? 'Safety check unavailable — held for your decision'
                      : 'Safety check disapproved — held for your decision'}
                  </strong>
                  <p>{trace.d1Check.reason}</p>
                  <span className="trace-verdict-meta mono">
                    match {trace.d1Check.noul === null ? 'unreported' : trace.d1Check.noul.toFixed(2)} ·
                    safety {trace.d1Check.destructiveSafety ?? 'unreported'} · pending edit · note untouched
                  </span>
                </div>
              </div>
            )}

            {trace.hold && trace.hold.kind !== 'd1' && (
              <div className="trace-verdict">
                <span className="trace-verdict-icon" aria-hidden="true">
                  {trace.hold.kind === 'blast-radius' || trace.hold.kind === 'blast-collapse' ? (
                    <Gauge size={11} />
                  ) : (
                    <X size={11} />
                  )}
                </span>
                <div>
                  <strong>{HOLD_TITLES[trace.hold.kind]}</strong>
                  <p>{trace.hold.reason}</p>
                  <span className="trace-verdict-meta mono">
                    {trace.status === 'pending'
                      ? 'waiting under Pending edits · note untouched'
                      : 'note untouched'}
                  </span>
                </div>
              </div>
            )}

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

            {/* Legacy supervisor-first stages: routing, d1-span grounding and
                the d1 critic never populate in the current modes (the
                interface model routes by typed directive, the worker grounds
                its own span, safety is the d1 check on the summary grid).
                They render only when a trace actually carries their data —
                legacy persisted traces keep them, current modes never see
                the empty sections. */}
            {trace.route && (
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
                      <span
                        className="trace-query-p mono"
                        title="measured by d1 · heuristic (local) · — unreported"
                      >
                        P {formatP(trace.route.actionConfidence)}
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
                          className={cx(
                            'trace-tool-score',
                            !pAdopted(tool.p, 0.25) && 'is-pruned',
                          )}
                          key={tool.name}
                          title={
                            tool.p === null
                              ? 'd1 chose this tool without reporting a probability'
                              : undefined
                          }
                        >
                          <span className="mono">{tool.name}</span>
                          <Meter
                            value={tool.p}
                            tone={pAdopted(tool.p, 0.25) ? 'accent' : 'orange'}
                          />
                          <span className="mono">{formatP(tool.p)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <p className="trace-reason">{trace.route.reason}</p>
                  <div className="trace-hint-row mono">
                    <span>
                      {trace.call
                        ? `${trace.call.toolSchemasInjected} schema${
                            trace.call.toolSchemasInjected === 1 ? '' : 's'
                          } injected into the worker prompt`
                        : `${
                            trace.route.allowedTools.filter((tool) => pAdopted(tool.p, 0.25)).length
                          } of ${TOOL_DEFS.length} tools above the adoption gate`}
                    </span>
                    {trace.route.directive && <span>directive: {trace.route.directive}</span>}
                  </div>
                </div>
              ) : (
                <p className="trace-muted">Routing pass pending.</p>
              )}
            </TraceSection>
            )}

            <TraceSection
              index="W"
              title="Worker generation"
              caption={
                trace.runtime?.worker === 'live'
                  ? 'LFM3-1.7B · live decode'
                  : 'template fallback'
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
                        deterministic template · no sampler sent
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
                  No worker call.
                  {trace.route?.action === 'conversational_only'
                    ? ' The turn stayed conversational — no file mutation.'
                    : ' The run stopped before generation.'}
                </p>
              )}
            </TraceSection>

            {trace.critic && (
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
                        <strong className="mono">{formatP(trace.critic.pCorrect)}</strong>
                      </div>
                      <Meter value={trace.critic.pCorrect} tone="accent" />
                    </div>
                    <div className="trace-critic-meter">
                      <div className="trace-critic-meter-head">
                        <span className="mono">P(destructive_safe)</span>
                        <strong className="mono">{formatP(trace.critic.pSafe)}</strong>
                      </div>
                      <Meter value={trace.critic.pSafe} tone="green" />
                    </div>
                  </div>
                  {trace.critic.pCorrect === null && trace.critic.pSafe === null && (
                    <p className="trace-muted">
                      p unreported — the verdict tracks the deterministic checks alone; numbers
                      never gate a local decision.
                    </p>
                  )}
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
            )}

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
                    : 'No rejected traces yet — the critic has not rejected any worker call this session'
                }
                onClick={downloadRejected}
              >
                <Download size={11} />
                Download rejected · JSONL
              </button>
            </div>
              </>
            ) : (
              <div className="exchange-list">
                {trace.exchanges?.length ? (
                  trace.exchanges.map((exchange, index) => (
                    <ExchangeCard
                      key={exchange.id}
                      exchange={exchange}
                      index={index}
                      total={trace.exchanges!.length}
                    />
                  ))
                ) : (
                  <div className="exchange-empty">
                    <div className="trace-empty-icon">
                      <ScanSearch size={20} />
                    </div>
                    <h3>No model exchanges recorded</h3>
                    <p>
                      This turn predates the inspector, or never reached a model (offline
                      pre-check, undo/redo directive). Every turn that calls a model — chat,
                      worker decode, retry, failure — records its request and response here.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  )

  return createPortal(content, document.body)
}
