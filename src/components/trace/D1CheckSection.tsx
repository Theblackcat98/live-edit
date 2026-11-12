import { X } from 'lucide-react'
import type { Trace } from '../../types'

/**
 * The d1 verdict banner. Rendered only for a check that did not approve —
 * an approved call proceeds and needs no warning.
 */
export function D1CheckSection({ check }: { check: NonNullable<Trace['d1Check']> }) {
  if (check.verdict === 'approved') return null
  return (
    <div className="trace-verdict">
      <span className="trace-verdict-icon" aria-hidden="true">
        <X size={11} />
      </span>
      <div>
        <strong>
          {check.verdict === 'unavailable'
            ? 'Safety check unavailable — held for your decision'
            : 'Safety check disapproved — held for your decision'}
        </strong>
        <p>{check.reason}</p>
        <span className="trace-verdict-meta mono">
          match {check.noul === null ? 'unreported' : check.noul.toFixed(2)} ·
          safety {check.destructiveSafety ?? 'unreported'} · pending edit · note untouched
        </span>
      </div>
    </div>
  )
}
