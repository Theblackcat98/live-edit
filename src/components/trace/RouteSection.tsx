import type { D1RouteRecord } from '../../types'
import { cx } from '../../lib/utils'
import { TraceSection } from './TraceSection'
import { ScoreBar } from './ScoreBar'
import { ROUTE_CONFIDENCE_MIN } from '../../lib/d1route'

const OUTCOME: Record<'worker' | 'chat' | 'ambiguous' | 'low', string> = {
  worker: 'Handed to the worker as an edit.',
  chat: 'Answered as conversation — nothing was edited.',
  ambiguous: 'Ambiguous — the reply stands and nothing was edited; rephrase to edit.',
  low: 'Edit intent, but below the confidence threshold — answered as conversation.',
}

/**
 * The d1 turn-routing verdict (audio mode). This is the only record of why a
 * turn did or did not reach the worker — on a chat-only turn it is the whole
 * decision.
 */
export function RouteSection({ route }: { route: D1RouteRecord }) {
  // Records written before the threshold was stored fall back to today's.
  const threshold = route.threshold ?? ROUTE_CONFIDENCE_MIN
  const isEdit = route.intent !== 'conversational' && route.intent !== 'ambiguous'
  const outcome = route.routesToWorker
    ? OUTCOME.worker
    : route.intent === 'ambiguous'
      ? OUTCOME.ambiguous
      : isEdit
        ? OUTCOME.low
        : OUTCOME.chat
  return (
    <TraceSection
      index="R"
      title="Routing"
      caption={`d1 · turn_intent · ${Math.round(route.ms)} ms${
        route.promptTokens ? ` · ${route.promptTokens} prompt tok` : ''
      }`}
    >
      <div className="trace-kv">
        <span className="trace-kv-key">intent</span>
        <span className="trace-kv-value">
          <span
            className={cx(
              'chip',
              isEdit ? 'chip-accent' : route.intent === 'ambiguous' ? 'chip-orange' : 'chip-ghost',
            )}
          >
            {route.intent}
          </span>
        </span>
        <span className="trace-kv-key">confidence</span>
        <span className="trace-kv-value">
          <ScoreBar
            value={route.confidence}
            threshold={threshold}
            tone={
              route.confidence === null
                ? 'unreported'
                : route.confidence >= threshold
                  ? 'pass'
                  : 'fail'
            }
          />
        </span>
        <span className="trace-kv-key">outcome</span>
        <span className="trace-kv-value trace-body">{outcome}</span>
      </div>
    </TraceSection>
  )
}
