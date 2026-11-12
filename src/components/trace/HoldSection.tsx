import { CircleAlert, Gauge, X } from 'lucide-react'
import type { Trace } from '../../types'
import { humanD1Reason } from '../../lib/d1reason'
import { cx } from '../../lib/utils'

/** Head-line for a turn that stopped or was held before execution (§8/§9). */
const HOLD_TITLES: Record<NonNullable<Trace['hold']>['kind'], string> = {
  'hard-gate': 'Stopped by a hard gate — cannot be overridden',
  'blast-radius': 'Blast-radius limit — held for your decision',
  'blast-collapse': 'Section-scale removal — held for your decision',
  'no-decision-model': 'No safety-check model in this mode — held for your decision',
  engine: 'The engine refused this call',
  outcome: 'Outcome check failed — nothing was written',
  d1: 'Safety check held this edit for your decision',
}

/**
 * The one banner that answers "what happened to my edit" for a turn that did
 * not apply. Held turns (orange) wait under Pending edits; stopped turns (red)
 * are over. d1 detail lives in the Safety check section — this is the summary.
 */
export function HoldSection({ trace }: { trace: Trace }) {
  const hold = trace.hold
  if (!hold) return null
  const held = trace.status === 'pending'
  const isD1 = hold.kind === 'd1'
  const title = isD1 && trace.d1Check?.verdict === 'unavailable'
    ? 'Safety check unavailable — held for your decision'
    : HOLD_TITLES[hold.kind]
  const reason = isD1 && trace.d1Check ? humanD1Reason(trace.d1Check) ?? hold.reason : hold.reason
  const Icon = hold.kind === 'blast-radius' || hold.kind === 'blast-collapse' ? Gauge : held ? CircleAlert : X
  return (
    <div className={cx('trace-banner', held ? 'is-held' : 'is-stopped')} role="status">
      <span className="trace-banner-icon" aria-hidden="true">
        <Icon size={12} />
      </span>
      <div className="trace-banner-main">
        <strong>{title}</strong>
        {reason && <p>{reason}</p>}
        <span className="trace-banner-meta">
          {held ? 'Waiting under Pending edits · note untouched' : 'Note untouched'}
        </span>
      </div>
    </div>
  )
}
