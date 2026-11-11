import { AudioLines } from 'lucide-react'
import type { PipelineStage } from '../types'
import type { RunMode } from '../lib/runmode'
import { chatModelShort } from '../lib/runmode'
import { cx, formatElapsed } from '../lib/utils'
import { Waveform, type WaveMode } from './Waveform'

interface VisualPanelProps {
  stage: PipelineStage
  /** Hands-free toggle (may be on while no recorder is live between utterances). */
  micOn: boolean
  /** True only while a recorder is actually capturing. */
  micActive: boolean
  speaking: boolean
  getMicLevel: () => number
  elapsedSeconds: number
  /** Active run mode — the speaking label names the chat model. */
  mode: RunMode
}

export function VisualPanel({
  stage,
  micOn,
  micActive,
  speaking,
  getMicLevel,
  elapsedSeconds,
  mode,
}: VisualPanelProps) {
  const stageActive =
    stage === 'routing' ||
    stage === 'grounding' ||
    stage === 'generating' ||
    stage === 'verifying' ||
    stage === 'executing'
  const waveMode: WaveMode = micActive
    ? 'listening'
    : speaking
      ? 'speaking'
      : stageActive
        ? 'processing'
        : 'idle'

  return (
    <section className="card visual-card">
      <header className="card-header visual-header">
        <div className="card-title">
          <AudioLines size={14} />
          Audio context
        </div>
        <div className="card-header-spacer" />
      </header>

      <div className="stage-waveband">
        <div className="stage-wave-meta">
          <span className="stage-wave-label mono">AUDIO</span>
          <span className="stage-wave-rate mono">16 kHz</span>
        </div>
        <Waveform mode={waveMode} getMicLevel={getMicLevel} bars={72} />
        <div className="stage-wave-status">
          <span
            className={cx(
              'status-dot',
              micActive && 'is-green is-pulsing',
              speaking && 'is-accent is-pulsing',
              !micActive && !speaking && stageActive && 'is-accent is-pulsing',
            )}
          />
          <span className="stage-wave-mode">
            {micActive
              ? 'Listening'
              : speaking
                ? `${chatModelShort(mode)} speaking`
                : stageActive
                  ? 'Working'
                  : micOn
                    ? 'Hands-free'
                    : 'Ambient'}
          </span>
          <span className="stage-wave-time mono">{formatElapsed(elapsedSeconds)}</span>
        </div>
      </div>
    </section>
  )
}
