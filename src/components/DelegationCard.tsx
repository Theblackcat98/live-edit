import { ArrowUpRight, Braces, Check, CircleAlert, LoaderCircle, X } from 'lucide-react'
import type { DelegationInfo } from '../types'
import { TOOL_LABELS } from '../data/tools'
import { cx } from '../lib/utils'

interface DelegationCardProps {
  delegation: DelegationInfo
  onOpenTrace: () => void
}

export function DelegationCard({ delegation, onOpenTrace }: DelegationCardProps) {
  // `checking`: the proposed call is inside the hard gates and (in d1 modes)
  // the safety check. `pending`: held for the user's ✓ / ✗ (design.md §9) —
  // by d1, the blast-radius rule, or a mode with no d1. `rejected`: a hard
  // gate, the engine dry-run or the outcome check stopped it before writing.
  const statusLabel = {
    generating: 'Writing call',
    checking: 'Checking',
    pending: 'Held for you',
    verified: 'Approved',
    executed: 'Applied',
    rejected: 'Stopped',
  }[delegation.status]
  const inFlight = delegation.status === 'generating' || delegation.status === 'checking'

  return (
    <div className={cx('delegation-card', `is-${delegation.status}`)}>
      <div className="delegation-main">
        <div className="delegation-head">
          <span className="delegation-icon">
            <Braces size={12} />
          </span>
          <span className="delegation-title">{delegation.modelLabel ?? '1.7B'} · tool call</span>
          <span
            className={cx(
              'delegation-status',
              delegation.status === 'executed' && 'is-green',
              inFlight && 'is-accent',
              delegation.status === 'pending' && 'is-orange',
              delegation.status === 'rejected' && 'is-red',
            )}
          >
            {inFlight ? (
              <LoaderCircle size={10} className="spin" />
            ) : delegation.status === 'rejected' ? (
              <X size={10} />
            ) : delegation.status === 'pending' ? (
              <CircleAlert size={10} />
            ) : (
              <Check size={10} />
            )}
            {statusLabel}
          </span>
        </div>
        <div className="delegation-tool">
          <span className="delegation-tool-name mono">{TOOL_LABELS[delegation.tool]}</span>
          <span className="delegation-tool-raw mono">{delegation.tool}</span>
          {typeof delegation.confidence === 'number' && (
            <span
              className="delegation-confidence mono"
              title="d1's does_call_match_directive score (0–1); 0.50 is the approval threshold"
            >
              match {delegation.confidence.toFixed(2)}
            </span>
          )}
        </div>
        {delegation.thought && (
          <p className="delegation-thought">{delegation.thought}</p>
        )}
        {delegation.status === 'checking' && (
          <p className="delegation-thought">
            Hard gates and the d1 safety check are running on the proposed call.
          </p>
        )}
        <div className="delegation-foot">
          <span className="mono">#{delegation.runId.slice(-4).toUpperCase()}</span>
          <button type="button" className="delegation-trace" onClick={onOpenTrace}>
            Open trace
            <ArrowUpRight size={10} />
          </button>
        </div>
      </div>
    </div>
  )
}
