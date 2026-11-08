import {
  Braces,
  CircleHelp,
  CloudOff,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { LogoMark } from './LogoMark'
import { TOTAL_MEMORY_GB } from '../data/models'
import { cx, formatElapsed } from '../lib/utils'

interface TopBarProps {
  title: string
  path: string
  elapsedSeconds: number
  speakerOn: boolean
  micOn: boolean
  traceAvailable: boolean
  onToggleSpeaker: () => void
  onToggleMic: () => void
  onOpenTrace: () => void
  onOpenHelp: () => void
}

export function TopBar({
  title,
  path,
  elapsedSeconds,
  speakerOn,
  micOn,
  traceAvailable,
  onToggleSpeaker,
  onToggleMic,
  onOpenTrace,
  onOpenHelp,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <LogoMark size={26} />
        <div className="brand-copy">
          <span className="brand-word">LiquidScribe</span>
          <span className="brand-tag mono">LOCAL</span>
        </div>
      </div>

      <div className="topbar-divider" />

      <div className="workspace-file">
        <span className="eyebrow">Workspace</span>
        <span className="workspace-file-name">
          {title}
          <span className="workspace-file-path mono">{path}</span>
        </span>
        <span className="local-status">
          <CloudOff size={11} />
          No server
        </span>
      </div>

      <div className="topbar-spacer" />

      <div className="trinity-summary" title="Simulated LFM3 residency · three models sharing a 24-layer tri-hybrid backbone">
        <span className="trinity-pips" aria-hidden="true">
          <span className="trinity-pip pip-green" />
          <span className="trinity-pip pip-accent" />
          <span className="trinity-pip pip-orange" />
        </span>
        <span className="trinity-label">Trinity</span>
        <span className="trinity-memory mono">{TOTAL_MEMORY_GB.toFixed(1)} GB</span>
      </div>

      <div className="topbar-divider" />

      <div className="live-clock" title="Session elapsed time">
        <span className="status-dot is-green is-pulsing" />
        <span className="live-label mono">LIVE</span>
        <span className="live-time mono">{formatElapsed(elapsedSeconds)}</span>
      </div>

      <div className="topbar-actions">
        <button
          type="button"
          className={cx('icon-button', micOn && 'is-active')}
          onClick={onToggleMic}
          aria-label={micOn ? 'Stop voice capture' : 'Start voice capture'}
          title={micOn ? 'Stop voice capture' : 'Speak a command'}
        >
          {micOn ? <Mic size={15} /> : <MicOff size={15} />}
        </button>
        <button
          type="button"
          className={cx('icon-button', speakerOn && 'is-active')}
          onClick={onToggleSpeaker}
          aria-label={speakerOn ? 'Mute spoken replies' : 'Enable spoken replies'}
          title={speakerOn ? 'Spoken replies on' : 'Spoken replies off'}
        >
          {speakerOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onOpenTrace}
          disabled={!traceAvailable}
          aria-label="Open decision trace"
          title="Open decision trace"
        >
          <Braces size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onOpenHelp}
          aria-label="About LiquidScribe"
          title="About this build"
        >
          <CircleHelp size={15} />
        </button>
      </div>
    </header>
  )
}
