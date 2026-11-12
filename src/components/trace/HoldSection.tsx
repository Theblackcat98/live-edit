import { Gauge, X } from 'lucide-react'
import type { Trace, TurnHold } from '../../types'
import { PendingEditSection } from './PendingEditSection'

/** Head-line for a turn that stopped or was held before execution (§8/§9). */
const HOLD_TITLES: Record<TurnHold['kind'], string> = {
  'hard-gate': 'Stopped by a hard gate — not overridable',
  'blast-radius': 'Blast-radius limit — held for your decision',
  'blast-collapse': 'Section-scale collapse (§8) — held for your decision',
  'no-decision-model': 'No decision model in this mode — held for your decision',
  engine: 'The engine refused this call',
  outcome: 'Outcome check failed — nothing was written',
  d1: 'Safety check — held for your decision',
}

/**
 * Any hold except a d1 one: d1 already has its own verdict banner, and two
 * blocks describing one refusal would read as two refusals.
 */
export function HoldSection({ hold, status }: { hold: TurnHold; status: Trace['status'] }) {
  if (hold.kind === 'd1') return null
  return (
    <div className="trace-verdict">
      <span className="trace-verdict-icon" aria-hidden="true">
        {hold.kind === 'blast-radius' || hold.kind === 'blast-collapse' ? (
          <Gauge size={11} />
        ) : (
          <X size={11} />
        )}
      </span>
      <div>
        <strong>{HOLD_TITLES[hold.kind]}</strong>
        <p>{hold.reason}</p>
        <PendingEditSection pending={status === 'pending'} />
      </div>
    </div>
  )
}
