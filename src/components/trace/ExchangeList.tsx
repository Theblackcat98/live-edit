import { useEffect, useState } from 'react'
import { CheckCheck, Clipboard, Copy, ScanSearch, Sparkles } from 'lucide-react'
import type { ExchangeMessage, TurnExchange } from '../../types'
import { cx } from '../../lib/utils'

function ExchangeMessagesView({ messages }: { messages: ExchangeMessage[] }) {
  return (
    <div className="exchange-messages">
      {messages.map((message, index) => (
        <div className="exchange-msg" key={index}>
          <span className={cx('exchange-msg-role mono', `r-${message.role}`)}>{message.role}</span>
          <div className="exchange-msg-body">
            {message.content && <pre className="mono">{message.content}</pre>}
            {message.toolCalls?.map((call, callIndex) => (
              <div className="exchange-msg-call" key={callIndex}>
                <span className="chip chip-accent mono">{call.name}</span>
                <pre className="mono">{call.arguments}</pre>
              </div>
            ))}
            {message.toolCallId && (
              <span className="exchange-msg-tool-id mono">answers {message.toolCallId}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function ExchangeCard({
  exchange,
  index,
  total,
}: {
  exchange: TurnExchange
  index: number
  total: number
}) {
  const [showContext, setShowContext] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setShowContext(false)
    setCopied(false)
  }, [exchange.id])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(exchange, null, 2))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be blocked outside a user gesture; the view stays intact.
    }
  }

  const response = exchange.response
  return (
    <article className={cx('exchange-card', !exchange.ok && 'is-failed')} data-exchange-label={exchange.label}>
      <header className="exchange-head">
        <span className="exchange-index mono">
          {index + 1}/{total}
        </span>
        <span className="chip chip-ghost mono">{exchange.role}</span>
        <strong className="exchange-model">{exchange.model}</strong>
        <span className="exchange-label mono">{exchange.label}</span>
        <span className={cx('chip mono', exchange.ok ? 'chip-green' : 'chip-red')}>
          {exchange.ok ? 'ok' : 'failed'}
        </span>
        <span className="mono">{Math.round(exchange.ms)} ms</span>
        <button
          type="button"
          className="icon-button"
          onClick={copy}
          aria-label="Copy exchange JSON"
          title="Copy exchange JSON"
        >
          {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
        </button>
      </header>
      <div className="exchange-meta mono">
        <span className="exchange-url">{exchange.url}</span>
        <span>temp {exchange.request.temperature}</span>
        <span>max_tokens {exchange.request.maxTokens ?? '∞'}</span>
        <span>{exchange.request.stream ? 'stream' : 'complete'}</span>
        {exchange.request.tools && <span>tools {exchange.request.tools.join(' + ')}</span>}
        {response && (
          <span>
            {response.promptTokens}→{response.outputTokens} tok
          </span>
        )}
        {response?.finishReason && (
          <span className={cx(response.finishReason === 'length' && 'is-truncated')}>
            finish {response.finishReason}
          </span>
        )}
      </div>
      {exchange.error && <div className="exchange-error mono">{exchange.error}</div>}
      {response?.reasoning && (
        <div className="trace-thought">
          <span className="trace-thought-label mono">
            <Sparkles size={10} />
            &lt;think&gt;
          </span>
          <p>{response.reasoning}</p>
        </div>
      )}
      {response?.text && <pre className="exchange-reply mono">{response.text}</pre>}
      {response && response.toolCalls.length > 0 && (
        <div className="exchange-calls">
          {response.toolCalls.map((call, callIndex) => (
            <div className="exchange-call" key={callIndex}>
              <span className="chip chip-accent mono">{call.name}</span>
              <pre className="mono">{call.arguments}</pre>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="trace-note-toggle mono"
        onClick={() => setShowContext((previous) => !previous)}
      >
        <Clipboard size={10} />
        {showContext ? 'Hide' : 'Show'} context sent · {exchange.request.messages.length} messages
      </button>
      {showContext && <ExchangeMessagesView messages={exchange.request.messages} />}
    </article>
  )
}

/** The Chat tab: every model request/response pair this turn recorded. */
export function ExchangeList({ exchanges }: { exchanges: TurnExchange[] }) {
  return (
    <div className="exchange-list">
      {exchanges.length ? (
        exchanges.map((exchange, index) => (
          <ExchangeCard
            key={exchange.id}
            exchange={exchange}
            index={index}
            total={exchanges.length}
          />
        ))
      ) : (
        <div className="exchange-empty">
          <div className="trace-empty-icon">
            <ScanSearch size={20} />
          </div>
          <h3>No model exchanges recorded</h3>
          <p>
            This turn predates the inspector, or never reached a model (offline
            pre-check, undo/redo directive). Every turn that calls a model — chat,
            worker decode, retry, failure — records its request and response here.
          </p>
        </div>
      )}
    </div>
  )
}
