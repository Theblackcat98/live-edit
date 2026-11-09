import { ArrowUpRight, Braces, Check, LoaderCircle, X } from 'lucide-react'
import type { DelegationInfo } from '../types'
import { TOOL_LABELS } from '../data/tools'
import { cx } from '../lib/utils'

interface DelegationCardProps {
  delegation: DelegationInfo
  onOpenTrace: () => void
}

export function DelegationCard({ delegation, onOpenTrace }: DelegationCardProps) {
  // `checking` (Phase-2 contract): the worker's proposed call is inside the
  // deterministic hard gates and the d1 safety check — in flight, nothing
  // decided yet (design.md §7/§8). `pending` is Phase 5's (design.md §9,
  // user adjudication): nothing produces it yet, so it deliberately falls
  // through to the neutral chip below until PendingEditCard lands.
  const statusLabel =
    delegation.status === 'generating'
      ? 'Generating XML'
      : delegation.status === 'checking'
        ? 'Gates + d1 check'
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
          <span className="delegation-title">{delegation.modelLabel ?? '1.7B'} · tool call</span>
          <span
            className={cx(
              'delegation-status',
              delegation.status === 'executed' && 'is-green',
              (delegation.status === 'generating' || delegation.status === 'checking') &&
                'is-accent',
              delegation.status === 'rejected' && 'is-red',
            )}
          >
            {delegation.status === 'generating' || delegation.status === 'checking' ? (
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
        {delegation.status === 'checking' && (
          <p className="delegation-thought">
            Hard gates and the d1 safety check are running on the proposed call.
          </p>
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
