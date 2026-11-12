import { ShieldCheck } from 'lucide-react'
import type { PipelineStage, RuntimeHealth, Trace } from '../types'
import { modeDef } from '../lib/modes'
import type { RunMode } from '../lib/runmode'
import { cx } from '../lib/utils'
import { modeHealth, modelHostLabel } from '../lib/runView'
interface StatusBarProps {
  stage: PipelineStage
  trace: Trace | null
  micOn: boolean
  micActive: boolean
  asrBusy: boolean
  runtimeHealth: RuntimeHealth | null
  /** Active run mode — ASR labels name the model actually transcribing. */
  mode: RunMode
}

const STAGE_LABEL: Record<PipelineStage, string> = {
  idle: 'Ready',
  routing: 'Reading the command',
  generating: '1.7B · generating call',
  verifying: 'd1 · safety check',
  executing: 'Engine · applying diff',
  complete: 'Committed',
}

function statusLabel(stage: PipelineStage, trace: Trace | null): string {
  if (stage === 'idle') return 'Ready'
  if (stage === 'complete' && trace) {
    if (trace.status === 'clarify') return 'Clarification requested'
    if (trace.status === 'conversational') return 'Conversation only'
    if (trace.status === 'pending') return 'Waiting for your decision'
    if (trace.status === 'rejected') return 'Held before writing'
    if (trace.status === 'failed') return 'Run stopped'
    return 'Applied · checked'
  }
  return STAGE_LABEL[stage]
}

function statusTone(stage: PipelineStage, trace: Trace | null): string {
  if (stage === 'idle') return 'is-green'
  if (stage === 'complete' && trace) {
    if (trace.status === 'rejected' || trace.status === 'failed') return 'is-red'
    if (trace.status === 'clarify' || trace.status === 'pending') return 'is-orange'
    return 'is-green'
  }
  return 'is-accent is-pulsing'
}

function formatMs(value: number | undefined): string {
  if (!value) return '—'
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
}

export function StatusBar({ stage, trace, micOn, micActive, asrBusy, runtimeHealth, mode }: StatusBarProps) {
  const active = stage !== 'idle' && stage !== 'complete'
  // Only the servers this mode needs count — an unused legacy server being
  // off is not a degraded runtime.
  const health = modeHealth(runtimeHealth, mode)
  const liveTone = !health ? 'statusbar-muted' : health.allUp ? 'is-green' : 'is-orange'
  const host = modelHostLabel()
  const asrModel = modeDef(mode).chat.transcriber
  // Honest three-state: a turn between utterances is not a live capture.
  const micLabel = asrBusy
    ? `${asrModel ?? 'ASR'} · transcribing`
    : micActive
      ? 'REC 16 kHz'
      : micOn
        ? 'MIC hands-free'
        : 'MIC standby'
  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-item" title={`The UI, tool engine and snapshots run in this tab. ${asrModel ? `Voice is transcribed by ${asrModel} on ${host}.` : 'No audio server in this mode — typing only.'}`}>
          <ShieldCheck size={12} />
          Local only
        </span>
        <span className="statusbar-sep">/</span>
        <span
          className={cx('statusbar-item', liveTone)}
          title={
            health
              ? health.needed
                  .map((endpoint) => `${endpoint.name} (${host}:${endpoint.port}) — ${endpoint.up ? 'up' : 'down'}`)
                  .join(' · ')
              : 'Probing local model servers…'
          }
        >
          {health
            ? health.allUp
              ? `Models up ${health.up}/${health.needed.length}`
              : `${health.down.length} of ${health.needed.length} models down`
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
          check <span className="mono">{formatMs(trace?.timings.critic)}</span>
        </span>
        <span className="statusbar-sep">/</span>
        <span className="statusbar-version mono">v0.9.0</span>
      </div>
    </footer>
  )
}
