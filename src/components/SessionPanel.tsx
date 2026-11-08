import { useEffect, useRef } from 'react'
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
import { cx, formatElapsed } from '../lib/utils'
import { MessageBubble } from './MessageBubble'

interface SessionPanelProps {
  messages: Message[]
  elapsedSeconds: number
  busy: boolean
  micOn: boolean
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
}: SessionPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const shortcut = isMac ? '⌘K' : 'Ctrl K'

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
  }, [messages, busy])

  const handleScroll = () => {
    const element = scrollRef.current
    if (!element) return
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 56
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const value = commandInput.trim()
    if (!value || busy) return
    onSubmit(value)
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

      <div className="session-transcript" ref={scrollRef} onScroll={handleScroll}>
        {messages.map((message, index) => (
          <MessageBubble
            key={message.id}
            message={message}
            recent={index >= messages.length - 2}
            onAction={onSubmit}
            onOpenTrace={onOpenTrace}
          />
        ))}
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

        <form
          className={cx('composer', micOn && 'is-listening', busy && 'is-busy', asrBusy && 'is-transcribing')}
          onSubmit={handleSubmit}
        >
          <button
            type="button"
            className={cx('composer-mic', micOn && 'is-active', asrBusy && 'is-busy')}
            onClick={onToggleMic}
            disabled={busy || asrBusy}
            aria-label={asrBusy ? 'Omni is transcribing' : micOn ? 'Stop and transcribe' : 'Speak a command'}
            title={asrBusy ? 'LFM3-Omni-2B is transcribing…' : micOn ? 'Stop and transcribe' : 'Speak a command'}
          >
            {asrBusy ? <LoaderCircle size={15} className="spin" /> : micOn ? <Mic size={15} /> : <MicOff size={15} />}
            {micOn && <span className="composer-mic-ring" aria-hidden="true" />}
          </button>
          <input
            id="command-input"
            className="composer-input"
            value={commandInput}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder={
              asrBusy
                ? 'Omni is transcribing your capture…'
                : micOn
                  ? 'Listening… speak, then pause or tap the mic'
                  : busy
                    ? 'Worker is applying a verified edit…'
                    : 'Ask Omni to change something…'
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
          >
            <ArrowUp size={14} />
          </button>
        </form>

        <div className="composer-hint">
          <span>Voice is transcribed by LFM3-Omni-2B on 127.0.0.1:8083</span>
          <span className="mono">Enter to send</span>
        </div>
      </div>
    </section>
  )
}
