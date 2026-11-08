import { ShieldCheck } from 'lucide-react'
import type { PipelineStage, RuntimeHealth, Trace } from '../types'
import { cx } from '../lib/utils'

interface StatusBarProps {
  stage: PipelineStage
  trace: Trace | null
  micOn: boolean
  asrBusy: boolean
  runtimeHealth: RuntimeHealth | null
}

const STAGE_LABEL: Record<PipelineStage, string> = {
  idle: 'Ready',
  routing: 'd1 · routing intent',
  grounding: 'd1 · grounding span',
  generating: 'VL · generating call',
  verifying: 'd1 · critic pass',
  executing: 'Engine · applying diff',
  complete: 'Committed',
}

function statusLabel(stage: PipelineStage, trace: Trace | null): string {
  if (stage === 'idle') return 'Ready'
  if (stage === 'complete' && trace) {
    if (trace.status === 'clarify') return 'Clarification requested'
    if (trace.status === 'conversational') return 'Conversation only'
    if (trace.status === 'rejected') return 'Call held by d1'
    if (trace.status === 'failed') return 'Run stopped'
    return 'Committed · verified'
  }
  return STAGE_LABEL[stage]
}

function statusTone(stage: PipelineStage, trace: Trace | null): string {
  if (stage === 'idle') return 'is-green'
  if (stage === 'complete' && trace) {
    if (trace.status === 'rejected' || trace.status === 'failed') return 'is-red'
    if (trace.status === 'clarify') return 'is-orange'
    return 'is-green'
  }
  return 'is-accent is-pulsing'
}

function formatMs(value: number | undefined): string {
  if (!value) return '—'
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
}

export function StatusBar({ stage, trace, micOn, asrBusy, runtimeHealth }: StatusBarProps) {
  const active = stage !== 'idle' && stage !== 'complete'
  const upCount = runtimeHealth?.endpoints.filter((endpoint) => endpoint.up).length ?? 0
  const totalEndpoints = runtimeHealth?.endpoints.length ?? 3
  const liveTone =
    !runtimeHealth ? 'statusbar-muted' : upCount === totalEndpoints ? 'is-green' : 'is-orange'
  const micLabel = asrBusy ? 'Omni · transcribing' : micOn ? 'REC 16 kHz' : 'MIC standby'
  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-item" title="The UI, tool engine and snapshots run in this tab. Voice is transcribed by LFM3-Omni-2B on 127.0.0.1:8083.">
          <ShieldCheck size={12} />
          Local only
        </span>
        <span className="statusbar-sep">/</span>
        <span
          className={cx('statusbar-item', liveTone)}
          title={
            runtimeHealth
              ? runtimeHealth.endpoints
                  .map((endpoint) => `${endpoint.name} (:${endpoint.port}) — ${endpoint.up ? 'up' : 'down'}`)
                  .join(' · ')
              : 'Probing local model servers…'
          }
        >
          {runtimeHealth
            ? upCount === totalEndpoints
              ? `Live models ${upCount}/${totalEndpoints}`
              : `Fallback · ${totalEndpoints - upCount} model${totalEndpoints - upCount === 1 ? '' : 's'} down`
            : 'Probing models…'}
        </span>
        <span className="statusbar-sep">/</span>
        <span className={cx('statusbar-item mono', asrBusy && 'is-orange')}>
          {micLabel}
        </span>
      </div>

      <div className={cx('statusbar-center', active && 'is-active')}>
        <span className={cx('status-dot', statusTone(stage, trace))} />
        <span>{statusLabel(stage, trace)}</span>
        {trace && stage !== 'idle' && (
          <span className="statusbar-run mono">#{trace.id.slice(-4).toUpperCase()}</span>
        )}
      </div>

      <div className="statusbar-right">
        <span className="statusbar-metric">
          route <span className="mono">{formatMs(trace?.timings.route)}</span>
        </span>
        <span className="statusbar-metric">
          ground <span className="mono">{formatMs(trace?.timings.ground)}</span>
        </span>
        <span className="statusbar-metric">
          critic <span className="mono">{formatMs(trace?.timings.critic)}</span>
        </span>
        <span className="statusbar-sep">/</span>
        <span className="statusbar-version mono">v0.9.0</span>
      </div>
    </footer>
  )
}
