import { ArrowUpRight, Braces, Check, LoaderCircle, X } from 'lucide-react'
import type { DelegationInfo } from '../types'
import { TOOL_LABELS } from '../data/tools'
import { cx } from '../lib/utils'

interface DelegationCardProps {
  delegation: DelegationInfo
  onOpenTrace: () => void
}

export function DelegationCard({ delegation, onOpenTrace }: DelegationCardProps) {
  const statusLabel =
    delegation.status === 'generating'
      ? 'Generating XML'
      : delegation.status === 'verified'
        ? 'Verified by d1'
        : delegation.status === 'executed'
          ? 'Executed'
          : 'Held by critic'

  return (
    <div className={cx('delegation-card', `is-${delegation.status}`)}>
      <div className="delegation-rail" aria-hidden="true" />
      <div className="delegation-main">
        <div className="delegation-head">
          <span className="delegation-icon">
            <Braces size={12} />
          </span>
          <span className="delegation-title">VL 2B · tool call</span>
          <span
            className={cx(
              'delegation-status',
              delegation.status === 'executed' && 'is-green',
              delegation.status === 'generating' && 'is-accent',
              delegation.status === 'rejected' && 'is-red',
            )}
          >
            {delegation.status === 'generating' ? (
              <LoaderCircle size={10} className="spin" />
            ) : delegation.status === 'rejected' ? (
              <X size={10} />
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
            <span className="delegation-confidence mono">
              P {delegation.confidence.toFixed(2)}
            </span>
          )}
        </div>
        {delegation.thought && (
          <p className="delegation-thought">{delegation.thought}</p>
        )}
        <div className="delegation-foot">
          <span className="mono">{delegation.runId.slice(-7).toUpperCase()}</span>
          <button type="button" className="delegation-trace" onClick={onOpenTrace}>
            Open trace
            <ArrowUpRight size={10} />
          </button>
        </div>
      </div>
    </div>
  )
}
