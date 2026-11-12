import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, CheckCheck, Copy, Download, ScanSearch, ShieldCheck, X } from 'lucide-react'
import type { RejectedTraceRecord, Trace } from '../types'
import { modeDef } from '../lib/modes'
import type { RunMode } from '../lib/runmode'
import { cx, pad, truncate } from '../lib/utils'
import {
  modelHostLabel,
  runShortId,
  runStatusLabel,
  runStatusTone,
  stageProvenance,
} from '../lib/runView'
import { TraceSummaryCells } from './trace/TraceSummaryCells'
import { D1CheckSection } from './trace/D1CheckSection'
import { HoldSection } from './trace/HoldSection'
import { ExchangeList } from './trace/ExchangeList'
import { DirectiveSection } from './trace/DirectiveSection'
import { RouteSection } from './trace/RouteSection'
import { WorkerSection } from './trace/WorkerSection'
import { ExecutionSection } from './trace/ExecutionSection'
import { TimingSection } from './trace/TimingSection'

interface TraceDrawerProps {
  rejectedTraces: RejectedTraceRecord[]
  open: boolean
  trace: Trace | null
  runs: Trace[]
  /** Active run mode — used only for runs that predate per-run mode recording. */
  mode: RunMode
  onSelectRun: (id: string) => void
  onClose: () => void
}

function clockOf(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const TONE_CHIP = {
  green: 'chip-green',
  orange: 'chip-orange',
  red: 'chip-red',
  accent: 'chip-accent',
  neutral: '',
} as const

const SOURCE_LABEL = { live: 'live', fallback: 'fallback', dictation: 'dictated' } as const

export function TraceDrawer({ open, trace, runs, rejectedTraces, mode, onSelectRun, onClose }: TraceDrawerProps) {
  // Captions name the model that served *this* run, not whatever mode is active now.
  const runDef = modeDef(trace?.runMode ?? mode)
  const chatShort = runDef.chat.short
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
    setTab('decision')
  }, [trace?.id, open])

  if (!open) return null

  const copyTrace = async () => {
    if (!trace) return
    try {
      // The whole recorded trace — exactly what the drawer renders from.
      await navigator.clipboard.writeText(JSON.stringify(trace, null, 2))
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

  const provenance = trace ? stageProvenance(trace) : []
  const exchangeCount = trace?.exchanges?.length ?? 0

  const content = (
    <div className="trace-overlay">
      <div className="trace-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="trace-drawer" role="dialog" aria-modal="true" aria-label="Decision trace">
        <header className="trace-header">
          <div className="trace-eyebrow">
            <Braces size={12} />
            <span>Decision trace</span>
            {trace && (
              <span className={cx('chip', TONE_CHIP[runStatusTone(trace.status)])}>
                {runStatusLabel(trace.status)}
              </span>
            )}
            <div className="trace-header-actions">
              <button
                type="button"
                className="icon-button"
                onClick={copyTrace}
                disabled={!trace}
                aria-label="Copy the full trace as JSON"
                title="Copy the full trace as JSON"
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
          <h2 className="trace-title" title={trace?.command}>
            {trace ? truncate(trace.command, 110) : 'No run selected'}
          </h2>
          {trace && (
            <div className="trace-subline mono">
              <span>{runShortId(trace, 6)}</span>
              <span>{clockOf(trace.at)}</span>
              <span>{trace.source === 'voice' ? 'spoken' : trace.source === 'demo' ? 'demo' : 'typed'}</span>
              <span>{runDef.info.label}</span>
              <span>note {trace.noteTokensAtStart} tok</span>
            </div>
          )}
          {provenance.length > 0 && (
            <div className="trace-provenance" aria-label="How each stage ran">
              {provenance.map((stage) => (
                <span
                  key={stage.id}
                  className={cx('trace-prov', `is-${stage.source}`)}
                  title={`${stage.label}: ${SOURCE_LABEL[stage.source]}`}
                >
                  <span className="trace-prov-dot" />
                  {stage.label}
                  <span className="trace-prov-source">{SOURCE_LABEL[stage.source]}</span>
                </span>
              ))}
            </div>
          )}
        </header>

        {!trace ? (
          <div className="trace-empty">
            <div className="trace-empty-icon">
              <ScanSearch size={20} />
            </div>
            <h3>No run yet</h3>
            <p>
              Talk to {chatShort}. Each turn records how it was routed, the brief the worker got,
              its tool call, the safety-check verdict and the diff here.
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
                    className={cx('trace-run-chip', run.id === trace.id && 'is-active')}
                    onClick={() => onSelectRun(run.id)}
                    title={`${truncate(run.command, 80)} · ${clockOf(run.at)}`}
                  >
                    <span className={cx('status-dot', `is-${runStatusTone(run.status)}`)} />
                    <span className="mono">{runShortId(run)}</span>
                    <span className="trace-run-status">{runStatusLabel(run.status)}</span>
                    <span className="trace-run-clock mono">{clockOf(run.at)}</span>
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
                Model calls
                {exchangeCount > 0 && <span className="trace-tab-count mono">{exchangeCount}</span>}
              </button>
            </div>
            {tab === 'decision' ? (
              <>
                <TraceSummaryCells trace={trace} chatShort={chatShort} />
                <HoldSection trace={trace} />
                {trace.d1Route && <RouteSection route={trace.d1Route} />}
                {trace.directive && (
                  <DirectiveSection
                    directive={trace.directive}
                    chatShort={chatShort}
                    routed={Boolean(trace.d1Route)}
                    repair={trace.omniRepair}
                  />
                )}
                <WorkerSection key={trace.id} trace={trace} />
                {trace.d1Check && <D1CheckSection check={trace.d1Check} />}
                {(trace.execution || trace.call) && <ExecutionSection execution={trace.execution} />}
                <TimingSection trace={trace} chatShort={chatShort} />
              </>
            ) : (
              <ExchangeList exchanges={trace.exchanges ?? []} hasD1={Boolean(trace.d1Route || trace.d1Check)} />
            )}
            <footer className="trace-footer">
              <ShieldCheck size={12} />
              <span>Engine runs in this tab · models on {modelHostLabel()}</span>
              <button
                type="button"
                className="button button-quiet trace-export-button"
                disabled={rejectedTraces.length === 0}
                title={
                  rejectedTraces.length
                    ? `Download ${rejectedTraces.length} rejected trace record${
                        rejectedTraces.length === 1 ? '' : 's'
                      } as JSONL`
                    : 'No rejected traces yet — nothing has been refused this session'
                }
                onClick={downloadRejected}
              >
                <Download size={12} />
                Rejected calls{rejectedTraces.length ? ` (${rejectedTraces.length})` : ''}
              </button>
            </footer>
          </div>
        )}
      </aside>
    </div>
  )

  return createPortal(content, document.body)
}
