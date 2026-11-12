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
import { ModeSwitch } from './ModeSwitch'
import { rosterMemoryGB } from '../data/models'
import { modeDef } from '../lib/modes'
import type { RunMode } from '../lib/runmode'
import { cx, formatElapsed } from '../lib/utils'

interface TopBarProps {
  title: string
  path: string
  elapsedSeconds: number
  speakerOn: boolean
  micOn: boolean
  traceAvailable: boolean
  /** Active run mode (which local models serve chat and edits). */
  mode: RunMode
  onSetMode: (mode: RunMode) => void
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
  mode,
  onSetMode,
  onToggleSpeaker,
  onToggleMic,
  onOpenTrace,
  onOpenHelp,
}: TopBarProps) {
  const roster = modeDef(mode).roster
  const memory = rosterMemoryGB(roster).toFixed(1)
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
        <span
          className="local-status"
          title="Nothing leaves your network: the note and audio go only to the local model servers."
        >
          <CloudOff size={11} />
          No cloud
        </span>
      </div>

      <div className="topbar-spacer" />

      <ModeSwitch mode={mode} onSetMode={onSetMode} />

      <div className="topbar-divider" />

      <div
        className="trinity-summary"
        title={`Models this mode runs: ${roster.map((model) => model.name).join(', ')} — ${memory} GB of weights`}
      >
        <span className="trinity-pips" aria-hidden="true">
          {roster.map((model) => (
            <span key={model.id} className={`trinity-pip pip-${model.color}`} />
          ))}
        </span>
        <span className="trinity-label">
          {roster.length} {roster.length === 1 ? 'model' : 'models'}
        </span>
        <span className="trinity-memory mono">{memory} GB</span>
      </div>

      <div className="topbar-divider" />

      <div className="live-clock" title="Session elapsed time">
        <span className="live-label mono">SESSION</span>
        <span className="live-time mono">{formatElapsed(elapsedSeconds)}</span>
      </div>

      <div className="topbar-actions">
        {/* Capability check, not a mode branch: low-RAM runs no
            Omni-architecture server, so the mic has nothing to record into. */}
        <button
          type="button"
          className={cx('icon-button', micOn && 'is-active')}
          onClick={onToggleMic}
          aria-pressed={micOn}
          aria-label={
            mode === 'lowram'
              ? 'Voice unavailable in low-RAM mode'
              : micOn
                ? 'Turn off hands-free listening'
                : 'Start hands-free listening'
          }
          title={
            mode === 'lowram'
              ? 'Low-RAM mode runs only LFM3-1.7B — type instead'
              : micOn
                ? 'Hands-free on — speak naturally; tap to stop listening'
                : 'Start hands-free listening — every utterance is transcribed until you tap stop'
          }
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
