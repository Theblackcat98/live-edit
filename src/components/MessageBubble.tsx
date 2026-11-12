import { Keyboard, Mic, ScanSearch } from 'lucide-react'
import type { Message } from '../types'
import { cx, pad } from '../lib/utils'
import { LogoMark } from './LogoMark'
import { TypewriterText } from './TypewriterText'
import { DelegationCard } from './DelegationCard'

interface MessageBubbleProps {
  message: Message
  onAction: (command: string) => void
  onOpenTrace: (runId?: string) => void
  recent?: boolean
}

function clockOf(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function durationOf(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${pad(seconds % 60)}`
}

export function MessageBubble({ message, onAction, onOpenTrace, recent }: MessageBubbleProps) {
  if (message.role === 'system') {
    return (
      <div className={cx('message-system', recent && 'is-recent')}>
        <span className="message-system-rule" />
        <span className="message-system-text mono">{message.text}</span>
        <span className="message-system-rule" />
      </div>
    )
  }

  if (message.role === 'tool' && message.delegation) {
    return (
      <div className={cx('message-row message-tool', recent && 'is-recent')}>
        <DelegationCard
          delegation={message.delegation}
          onOpenTrace={() => onOpenTrace(message.delegation?.runId)}
        />
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className={cx('message-row message-user', recent && 'is-recent')}>
        <div className="message-user-meta">
          <span className="message-user-source mono">
            {message.source === 'text' ? <Keyboard size={9} /> : <Mic size={9} />}
            {message.source === 'demo' ? 'DEMO' : message.source === 'voice' ? 'VOICE' : 'TYPED'}
            {message.durationSec ? ` · ${durationOf(message.durationSec)}` : ''}
          </span>
          <span className="message-time mono">{clockOf(message.at)}</span>
        </div>
        <div className="message-user-bubble">{message.text}</div>
      </div>
    )
  }

  return (
    <div className={cx('message-row message-assistant', recent && 'is-recent')}>
      <div className="message-avatar">
        <LogoMark size={18} />
      </div>
      <div className="message-assistant-content">
        <div className="message-assistant-meta">
          <span className="message-author">{message.author ?? 'Assistant'}</span>
          {message.kind === 'error' && (
            <span className="message-tag message-tag-error mono">error</span>
          )}
          <span className="message-time mono">{clockOf(message.at)}</span>
          {message.runId && (
            <button
              type="button"
              className="message-inspect"
              onClick={() => onOpenTrace(message.runId)}
              aria-label="Inspect this turn"
              title="Inspect this turn — context, thinking, tool calls"
            >
              <ScanSearch size={10} />
              <span className="mono">inspect</span>
            </button>
          )}
        </div>
        <p className="message-assistant-text">
          <TypewriterText text={message.text} />
          {message.streaming && <span className="typewriter-caret" aria-hidden="true" />}
        </p>
        {message.actions && message.actions.length > 0 && (
          <div className="message-actions">
            {message.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="message-action"
                onClick={() => onAction(action.command)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
