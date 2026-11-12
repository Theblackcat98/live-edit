import { useEffect, useMemo, useRef } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowUp,
  Eye,
  LoaderCircle,
  Mic,
  MicOff,
  MessageSquarePlus,
  MinusCircle,
  Play,
  ScanLine,
  Square,
  StopCircle,
  Table2,
} from 'lucide-react'
import type { Message, Suggestion } from '../types'
import { modeDef } from '../lib/modes'
import { cx, formatElapsed } from '../lib/utils'
import type { RunMode } from '../lib/runmode'
import type { PendingEdit } from '../types'
import { MessageBubble } from './MessageBubble'
import { modelHostLabel } from '../lib/runView'
import { PendingEditCard } from './PendingEditCard'

interface SessionPanelProps {
  messages: Message[]
  elapsedSeconds: number
  busy: boolean
  micOn: boolean
  micActive: boolean
  asrBusy: boolean
  demoRunning: boolean
  speaking: boolean
  ttsBusy: boolean
  suggestions: Suggestion[]
  commandInput: string
  onInputChange: (value: string) => void
  onSubmit: (command: string) => void
  onToggleMic: () => void
  onStopSpeech: () => void
  onResetChat: () => void
  onRunDemo: () => void
  onOpenTrace: (runId?: string) => void
  /** Pending edits (design.md §9): the adjudication queue rendered under the transcript. */
  pendingEdits: PendingEdit[]
  onApplyPending: (id: string) => void
  onDismissPending: (id: string) => void
  /** Active run mode — decides the composer hint and placeholder honestly. */
  mode: RunMode
  /** Desktop/tablet keeps the composer inside the session card; the phone
   * surface renders the same form as a persistent command bar instead. */
  showComposer?: boolean
}

/** One chronological transcript entry — a chat bubble or a pending-edit card. */
type TimelineItem =
  | { kind: 'message'; at: number; message: Message }
  | { kind: 'pending'; at: number; edit: PendingEdit }

interface SessionComposerProps {
  busy: boolean
  micOn: boolean
  micActive: boolean
  asrBusy: boolean
  commandInput: string
  onInputChange: (value: string) => void
  onSubmit: (command: string) => void
  onToggleMic: () => void
  /** Active run mode (mic availability and placeholder wording). */
  mode: RunMode
}

/** Where voice/speech actually go in each mode — never a claim of an unused server. */
function modeHint(mode: RunMode): string {
  const host = modelHostLabel()
  switch (mode) {
    case 'audio':
      return `Voice is transcribed by LFM3-Audio-2B on ${host}:8086`
    case 'omni':
      return `Voice is transcribed by LFM3-Omni-2B on ${host}:8083 (legacy)`
    case 'worker-d1':
      return `Voice and speech use d1-Omni-2B on ${host}:8085 · LFM3-1.7B answers chat`
    default:
      return 'Voice needs an audio server — type instead'
  }
}

const MODE_PLACEHOLDERS: Record<RunMode, string> = {
  audio: 'Ask Audio to change something…',
  omni: 'Ask Omni to change something… (legacy)',
  'worker-d1': 'Ask the 1.7B to change something…',
  lowram: 'Type a command for the 1.7B…',
}

const SUGGESTION_ICONS = {
  table: Table2,
  remove: MinusCircle,
  scan: ScanLine,
  eye: Eye,
}

export function SessionPanel({
  messages,
  elapsedSeconds,
  busy,
  micOn,
  micActive,
  asrBusy,
  demoRunning,
  speaking,
  ttsBusy,
  suggestions,
  commandInput,
  onInputChange,
  onSubmit,
  onToggleMic,
  onStopSpeech,
  onResetChat,
  onRunDemo,
  onOpenTrace,
  pendingEdits,
  onApplyPending,
  onDismissPending,
  mode,
  showComposer = true,
}: SessionPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  // The transcript is one timeline: chat bubbles and pending-edit cards
  // interleave by when they happened (message.at / edit.createdAt), so a held
  // edit sits where it occurred instead of piling up at the bottom. Stable
  // sort keeps same-timestamp entries in insertion order.
  const timeline = useMemo<TimelineItem[]>(
    () =>
      [
        ...messages.map((message) => ({ kind: 'message' as const, at: message.at, message })),
        ...pendingEdits.map((edit) => ({ kind: 'pending' as const, at: edit.createdAt, edit })),
      ].sort((a, b) => a.at - b.at),
    [messages, pendingEdits],
  )
  const recentIds = useMemo(() => new Set(messages.slice(-2).map((message) => message.id)), [messages])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || !stickToBottom.current) return
    const frame = window.requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    })
    const timer = window.setTimeout(() => {
      if (stickToBottom.current) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
      }
    }, 900)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [messages, busy, pendingEdits])

  const handleScroll = () => {
    const element = scrollRef.current
    if (!element) return
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 56
  }

  return (
    <section className="card session-card">
      <header className="card-header session-header">
        <div className="card-title">
          <span className={cx('status-dot', busy ? 'is-accent is-pulsing' : 'is-green')} />
          Live session
        </div>
        <span className="session-clock mono">{formatElapsed(elapsedSeconds)}</span>
        <div className="card-header-spacer" />
        <button
          type="button"
          className={cx('button button-quiet session-demo', speaking || ttsBusy ? 'is-running' : '')}
          onClick={onStopSpeech}
          disabled={!speaking && !ttsBusy}
          title={ttsBusy ? 'Stop generating audio' : speaking ? 'Stop audio playback' : 'Nothing playing'}
        >
          <StopCircle size={11} />
          Stop audio
        </button>
        <button
          type="button"
          className={cx('button button-quiet session-demo', demoRunning && 'is-running')}
          onClick={onRunDemo}
          title={demoRunning ? 'Stop the guided demo' : 'Run a guided four-command demo'}
        >
          {demoRunning ? <Square size={10} /> : <Play size={11} />}
          {demoRunning ? 'Stop' : 'Demo'}
        </button>
        <button
          type="button"
          className="button button-quiet session-demo"
          onClick={onResetChat}
          disabled={busy}
          title="Clear the conversation and decision traces (the note and snapshots stay)"
        >
          <MessageSquarePlus size={11} />
          New chat
        </button>
      </header>

      <div
        className="session-transcript"
        data-testid="session-transcript"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {timeline.map((item) =>
          item.kind === 'message' ? (
            <MessageBubble
              key={item.message.id}
              message={item.message}
              recent={recentIds.has(item.message.id)}
              onAction={onSubmit}
              onOpenTrace={onOpenTrace}
            />
          ) : (
            <div className="message-row message-pending" key={item.edit.id}>
              <PendingEditCard
                edit={item.edit}
                busy={busy}
                onApply={onApplyPending}
                onDiscard={onDismissPending}
              />
            </div>
          ),
        )}
      </div>

      <div className="session-compose">
        <div className="suggestion-row" aria-label="Suggested commands">
          {suggestions.slice(0, 3).map((suggestion) => {
            const Icon = SUGGESTION_ICONS[suggestion.icon]
            return (
              <button
                key={suggestion.label}
                type="button"
                className="suggestion-chip"
                onClick={() =>
                  suggestion.mode === 'draft'
                    ? onInputChange(suggestion.command)
                    : onSubmit(suggestion.command)
                }
                disabled={busy}
                title={suggestion.mode === 'draft' ? suggestion.command : `Send: ${suggestion.command}`}
              >
                <Icon size={11} />
                {suggestion.label}
              </button>
            )
          })}
        </div>

        {showComposer && (
          <SessionComposer
            busy={busy}
            micOn={micOn}
            micActive={micActive}
            asrBusy={asrBusy}
            commandInput={commandInput}
            onInputChange={onInputChange}
            onSubmit={onSubmit}
            onToggleMic={onToggleMic}
            mode={mode}
          />
        )}

        <div className="composer-hint">
          <span>{modeHint(mode)}</span>
          <span className="mono">Enter to send</span>
        </div>
      </div>
    </section>
  )
}

export function SessionComposer({
  busy,
  micOn,
  micActive,
  asrBusy,
  commandInput,
  onInputChange,
  onSubmit,
  onToggleMic,
  mode,
}: SessionComposerProps) {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const shortcut = isMac ? '⌘K' : 'Ctrl K'
  // Capability check through the registry: a mode with no speech endpoint has
  // no microphone path (low-RAM keeps the text composer only).
  const voiceAvailable = modeDef(mode).speech !== null

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const value = commandInput.trim()
    if (!value || busy) return
    onSubmit(value)
  }

  return (
    <form
      className={cx(
        'composer',
        micActive && 'is-listening',
        busy && 'is-busy',
        asrBusy && 'is-transcribing',
      )}
      onSubmit={handleSubmit}
      data-testid="composer"
      data-capturing={micActive ? 'true' : 'false'}
      data-mic-on={micOn ? 'true' : 'false'}
      data-transcribing={asrBusy ? 'true' : 'false'}
    >
      <button
        type="button"
        className={cx('composer-mic', micOn && 'is-active', asrBusy && 'is-busy')}
        onClick={onToggleMic}
        disabled={busy || asrBusy}
        aria-pressed={micOn}
        aria-label={
          !voiceAvailable
            ? 'Voice unavailable in low-RAM mode'
            : asrBusy
              ? 'Transcribing'
              : micOn
                ? 'Turn off hands-free listening'
                : 'Start hands-free listening'
        }
        title={
          !voiceAvailable
            ? 'Low-RAM mode runs only LFM3-1.7B — type instead'
            : asrBusy
              ? `${modeHint(mode)} — transcribing…`
              : micOn
                ? 'Hands-free on — each utterance is transcribed; tap to stop listening'
                : 'Start hands-free listening — every utterance is transcribed until you tap stop'
        }
        data-testid="composer-mic"
      >
        {asrBusy ? <LoaderCircle size={15} className="spin" /> : micOn ? <Mic size={15} /> : <MicOff size={15} />}
        {micActive && <span className="composer-mic-ring" aria-hidden="true" />}
      </button>
      <input
        id="command-input"
        className="composer-input"
        value={commandInput}
        onChange={(event) => onInputChange(event.target.value)}
        placeholder={
          asrBusy
            ? 'Transcribing your capture…'
            : micActive
              ? 'Listening — speak, then pause. Tap the mic to turn off.'
              : busy
                ? 'Working on your last turn…'
                : micOn
                  ? 'Starting the microphone…'
                  : MODE_PLACEHOLDERS[mode]
        }
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
        aria-label="Command input"
      />
      <span className="composer-shortcut mono">{shortcut}</span>
      <button
        type="submit"
        className="composer-send"
        disabled={busy || !commandInput.trim()}
        aria-label="Send command"
        title="Send command"
        data-testid="composer-send"
      >
        <ArrowUp size={14} />
      </button>
    </form>
  )
}
