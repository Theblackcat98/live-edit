import { Check, Clock, X } from 'lucide-react'
import type { PendingEdit } from '../types'
import { TOOL_LABELS } from '../data/tools'

interface PendingEditCardProps {
  pending: PendingEdit
  busy: boolean
  onApply: (id: string) => void
  onDismiss: (id: string) => void
}

/**
 * User adjudication for a held edit (design.md §9). The card shows exactly
 * what would change — the diff as authored, the directive it came from, and
 * why the safety check held it — and nothing else: ✓ applies (hard gates
 * re-run first, in the hook), ✗ discards onto the rejected-traces record.
 */
export function PendingEditCard({ pending, busy, onApply, onDismiss }: PendingEditCardProps) {
  const { diff } = pending
  return (
    <div className="pending-card" data-testid="pending-edit-card">
      <div className="pending-head">
        <span className="pending-badge">
          <Clock size={10} />
          Pending edit
        </span>
        <span className="pending-tool mono">{TOOL_LABELS[pending.call.name]}</span>
        <span className="pending-time mono">
          {new Date(pending.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <p className="pending-instruction">“{pending.directive.instruction}”</p>
      <p className="pending-reason">
        {pending.d1.verdict === 'unavailable'
          ? 'The safety check was unavailable, so this edit was held for you instead of being decided automatically.'
          : 'The safety check disapproved this edit.'}
        {typeof pending.d1.noul === 'number' && (
          <span className="mono"> Critic score {pending.d1.noul.toFixed(2)}.</span>
        )}
        {pending.d1.reason && <> {pending.d1.reason}</>}
      </p>
      <div className="trace-diff pending-diff">
        <div className="trace-diff-meta mono">
          <span>
            line {diff.startLine}
            {diff.before.length > 1 ? `–${diff.startLine + diff.before.length - 1}` : ''}
          </span>
          <span className="trace-diff-added">+{diff.added} added</span>
          <span className="trace-diff-removed">−{diff.removed} removed</span>
        </div>
        <div className="trace-diff-body">
          {diff.before.map((line, index) => (
            <div key={`b-${index}`} className="trace-diff-line is-before">
              <span>−</span>
              <code>{line || ' '}</code>
            </div>
          ))}
          {diff.after.map((line, index) => (
            <div key={`a-${index}`} className="trace-diff-line is-after">
              <span>+</span>
              <code>{line || ' '}</code>
            </div>
          ))}
        </div>
      </div>
      <div className="pending-actions">
        <button
          type="button"
          className="button button-primary pending-apply"
          disabled={busy}
          onClick={() => onApply(pending.id)}
        >
          <Check size={13} />
          Apply edit
        </button>
        <button
          type="button"
          className="button button-quiet pending-discard"
          disabled={busy}
          onClick={() => onDismiss(pending.id)}
        >
          <X size={13} />
          Discard
        </button>
      </div>
    </div>
  )
}
