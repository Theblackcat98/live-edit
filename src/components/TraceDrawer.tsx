import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Braces,
  CheckCheck,
  Copy,
  ScanSearch,
  ShieldCheck,
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
import { DirectiveSection } from './trace/DirectiveSection'
import { WorkerSection } from './trace/WorkerSection'
import { ExecutionSection } from './trace/ExecutionSection'
import { TimingSection } from './trace/TimingSection'

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

export function TraceDrawer({ open, trace, runs, rejectedTraces, mode, onSelectRun, onClose }: TraceDrawerProps) {
  const chatShort = modeDef(mode).chat.short
  const [tab, setTab] = useState<'decision' | 'chat'>('decision')
  const [copied, setCopied] = useState(false)

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
              <DirectiveSection directive={trace.directive} chatShort={chatShort} />
            )}

            <WorkerSection key={trace.id} trace={trace} />

            <ExecutionSection execution={trace.execution} />

            <TimingSection trace={trace} />

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
