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
        <strong className="exchange-model">{exchange.model}</strong>
        <span className="exchange-label">{exchange.role === 'chat' ? 'chat' : 'worker'} · {exchange.label}</span>
        <span className={cx('chip', exchange.ok ? 'chip-green' : 'chip-red')}>
          {exchange.ok ? 'ok' : 'failed'}
        </span>
        <span className="exchange-ms mono">{Math.round(exchange.ms)} ms</span>
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
        <span>max_tokens {exchange.request.maxTokens ?? 'uncapped'}</span>
        <span>{exchange.request.stream ? 'stream' : 'complete'}</span>
        {exchange.request.tools && <span>tools {exchange.request.tools.join(' + ')}</span>}
        {response && (
          <span title="prompt tokens → output tokens, as reported by the server">
            {response.promptTokens} in → {response.outputTokens} out
          </span>
        )}
        {response?.finishReason && (
          <span className={cx(response.finishReason === 'length' && 'is-truncated')}>
            finish {response.finishReason}
          </span>
        )}
        {response?.timings?.tokensPerSecond !== undefined && (
          <span title="generation speed the server reported">
            {response.timings.tokensPerSecond.toFixed(1)} tok/s
          </span>
        )}
        {response?.timings?.cachedTokens !== undefined && response.timings.cachedTokens > 0 && (
          <span title="prompt tokens the server reused from its prompt cache">
            {response.timings.cachedTokens} cached
          </span>
        )}
        {exchange.servedModel && !exchange.servedModel.toLowerCase().includes(exchange.model.toLowerCase()) && (
          <span title="the model id the server reported in its reply">served as {exchange.servedModel}</span>
        )}
      </div>
      {exchange.error && <div className="exchange-error mono">{exchange.error}</div>}
      {response?.reasoning && (
        <div className="trace-thought">
          <span className="trace-thought-label">
            <Sparkles size={11} />
            Reasoning
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
        <Clipboard size={11} />
        {showContext ? 'Hide' : 'Show'} the {exchange.request.messages.length} messages sent
      </button>
      {showContext && <ExchangeMessagesView messages={exchange.request.messages} />}
    </article>
  )
}

/**
 * The Model calls tab: every chat-completion request/response this turn
 * recorded. d1 calls return typed scores, not messages — they are shown on
 * the Decision tab (Routing, Safety check), and the list says so.
 */
export function ExchangeList({ exchanges, hasD1 }: { exchanges: TurnExchange[]; hasD1: boolean }) {
  return (
    <div className="exchange-list">
      {hasD1 && (
        <p className="trace-footnote exchange-note">
          d1 calls (routing, safety check) return scores rather than messages — see the Decision tab.
        </p>
      )}
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
          <h3>No chat-completion calls recorded</h3>
          <p>
            This turn never called a chat model (undo/redo, an offline stop), or it predates
            the inspector. Chat replies, worker decodes, retries and failures are recorded here.
          </p>
        </div>
      )}
    </div>
  )
}
