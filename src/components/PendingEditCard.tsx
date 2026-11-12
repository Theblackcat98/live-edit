import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleAlert, FileDiff, TriangleAlert, Check, X } from 'lucide-react'
import type { ExecutionDiff, PendingEdit } from '../types'
import { TOOL_LABELS } from '../data/tools'
import { humanD1Reason } from '../lib/d1reason'
import { cx, truncate } from '../lib/utils'

/**
 * PendingEditCard — design.md §9 (user adjudication), architecture-refactor.md
 * §9.3. A d1 disapproval (or an unavailable d1) becomes a decision for the
 * user instead of a dead end: the card shows the proposed diff, the worker's
 * tool, one line of what was asked, d1's verdict + scores + reason, and real
 * ✓ / ✗ controls. Until ✓, a pending edit modifies nothing — not the note,
 * the snapshot stack, or the undo chain.
 *
 * Mounted by SessionPanel at its timestamp's place in the timeline;
 * useWorkspace resolves statuses. This component renders every state —
 * pending, busy, stale, applied, discarded — safely on its own.
 *
 * The card is collapsible: a live decision opens expanded (the whole point is
 * adjudication); a resolved card lingers collapsed to one summary row unless
 * reopened — resolved cards accumulate and must not eat the transcript.
 *
 * Props contract for the wiring:
 *   edit:    the PendingEdit (design.md §9 shape) to render
 *   busy:    a turn is in flight — adjudication must wait (§9.4): both
 *            buttons render disabled with the reason shown
 *   onApply: called with edit.id when the user taps ✓ (hard gates re-run in
 *            the wiring before anything is written)
 *   onDiscard: called with edit.id when the user taps ✗ (nothing is written;
 *            the wiring appends the proposal to the rejected-traces log)
 */

// Accessibility contract of the two adjudication controls. Exported so the
// wiring's tests (and this repo's discipline of asserting user-facing copy)
// can pin them without a DOM.
export const APPLY_LABEL = 'Apply proposed edit'
export const DISCARD_LABEL = 'Discard proposed edit'

/** Collapsed-by-default policy: the live decision opens, resolutions close. */
export function defaultCollapsed(status: PendingEdit['status']): boolean {
  return status !== 'pending'
}

export interface PendingVerdictChip {
  label: string
  tone: 'red' | 'orange'
}

/**
 * The verdict chip copy (design.md §7/§9): a real disapproval vs an
 * unavailable d1 are different situations — the latter hands the decision to
 * the user without the safety model's opinion, and the card says so.
 */
export function verdictChip(verdict: PendingEdit['d1']['verdict']): PendingVerdictChip {
  if (verdict === 'approved') {
    // Reachable only via the §8 blast-radius hold (issue #58): d1 approved,
    // but a section-scale collapse never executes silently.
    return { label: 'd1 approved — held by the §8 blast-radius rule', tone: 'orange' }
  }
  return verdict === 'unavailable'
    ? { label: 'd1 unavailable — your call', tone: 'orange' }
    : { label: 'Disapproved by d1', tone: 'red' }
}

/**
 * d1's scores, rendered only from real numbers (runtime honesty — design.md
 * §2.7: no fabricated probabilities). `null` noul or null destructiveSafety
 * means unreported; when nothing was measured, nothing is shown.
 */
export function scoreSummary(d1: PendingEdit['d1']): string | null {
  const parts: string[] = []
  if (typeof d1.noul === 'number') parts.push(`match ${d1.noul.toFixed(2)}`)
  if (d1.destructiveSafety) {
    parts.push(
      d1.destructiveSafety === 'safe'
        ? 'safety safe'
        : 'safety unintended data loss',
    )
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Why d1 held the edit, in one human sentence (d1reason.ts maps the failing
 * question); the machine reason stays available in the title tooltip. Null
 * only when there is nothing to explain.
 */
export function reasonLine(d1: PendingEdit['d1']): string | null {
  if (!d1.reason) return null
  return humanD1Reason(d1) ?? d1.reason
}

/** The one line of "what was asked" (design.md §9): the directive's brief. */
export function askedLine(instruction: string): string {
  return truncate(instruction, 90)
}

/** One-line summary of the proposed diff: touched range + added/removed counts. */
export function diffSummary(diff: ExecutionDiff): string {
  const endLine = diff.startLine + Math.max(diff.before.length, diff.after.length) - 1
  const range =
    endLine > diff.startLine ? `L${diff.startLine}–${endLine}` : `L${diff.startLine}`
  return `${range} · +${diff.added} / −${diff.removed}`
}

/**
 * Why adjudication is disabled right now (architecture-refactor.md §9.4: a
 * pending edit is not a turn and must respect the busy discipline — exactly
 * like undo today). Null when the card is actionable.
 */
export function busyReason(busy: boolean): string | null {
  return busy ? 'A worker run is active — decide once the turn finishes.' : null
}

/** Head-line copy per card state; the pending state is the live decision. */
export function statusTitle(status: PendingEdit['status']): string {
  switch (status) {
    case 'applied':
      return 'Pending edit — applied'
    case 'discarded':
      return 'Pending edit — discarded'
    case 'stale':
      return 'Pending edit — stale'
    default:
      return 'Pending edit — your call'
  }
}

/**
 * The explanation line for a resolved state (design.md §8/§9): stale explains
 * the drift and never offers ✓ / ✗ (a hard-gate failure is not an
 * adjudication choice); applied/discarded are the muted resolutions the
 * wiring keeps briefly in the queue. Null while pending.
 */
export function statusExplanation(status: PendingEdit['status']): string | null {
  switch (status) {
    case 'stale':
      return 'The text this edit was written against has changed — the anchor no longer matches the note. Nothing was written; ask for the same change again to rebuild it.'
    case 'applied':
      return 'Applied to the note — snapshot pushed.'
    case 'discarded':
      return 'Discarded — nothing was written; the proposal was appended to the rejected-traces log.'
    default:
      return null
  }
}

interface PendingEditCardProps {
  edit: PendingEdit
  busy: boolean
  onApply: (id: string) => void
  onDiscard: (id: string) => void
}

export function PendingEditCard({ edit, busy, onApply, onDiscard }: PendingEditCardProps) {
  // Only a live pending edit adjudicates. Stale/applied/discarded cards are
  // rendered read-only: the wiring owns resolving them, the card never
  // fakes an action for a state that already ended.
  const actionable = edit.status === 'pending'
  // Collapse follows the state (live decision open, resolutions closed) until
  // the user toggles; the override survives status changes — a card the user
  // reopened stays open, one they closed stays closed.
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null)
  const collapsed = collapseOverride ?? defaultCollapsed(edit.status)
  const chip = verdictChip(edit.d1.verdict)
  const scores = scoreSummary(edit.d1)
  const reason = reasonLine(edit.d1)
  const explanation = statusExplanation(edit.status)
  const busyNote = busyReason(busy)
  const ask = askedLine(edit.directive.instruction)
  const toggle = () => setCollapseOverride(!collapsed)

  return (
    <article
      className={cx('pending-card', `is-${edit.status}`, actionable && busy && 'is-busy', collapsed && 'is-collapsed')}
    >
      <span className="pending-rail" aria-hidden="true" />
      <div className="pending-main">
        <button
          type="button"
          className="pending-head"
          onClick={toggle}
          aria-expanded={!collapsed}
          title={collapsed ? 'Show the proposed edit' : 'Collapse to one line'}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          <span className="pending-icon">
            <FileDiff size={12} />
          </span>
          <span className="pending-title">{statusTitle(edit.status)}</span>
          <span className={cx('pending-verdict', `is-${chip.tone}`)}>
            {edit.d1.verdict === 'disapproved' ? <X size={10} /> : <CircleAlert size={10} />}
            {chip.label}
          </span>
        </button>

        {collapsed ? (
          <p className="pending-collapsed-meta">
            <span className="mono">{TOOL_LABELS[edit.call.name]} · {diffSummary(edit.diff)}</span>
            <span className="pending-collapsed-asked">{ask}</span>
          </p>
        ) : (
          <>
            <div className="pending-tool">
              <span className="pending-tool-name mono">{TOOL_LABELS[edit.call.name]}</span>
              <span className="pending-tool-raw mono">{edit.call.name}</span>
              <span className="pending-diff-meta mono">{diffSummary(edit.diff)}</span>
            </div>

            <p className="pending-asked" title={edit.directive.instruction}>
              <span className="pending-asked-label">Asked:</span> {ask}
            </p>

            {/* Same before/after pattern as the trace drawer's ExecutionDiff body
                (execution section E) — proposed styling, not applied green. */}
            <div className="pending-diff" aria-label="Proposed diff — not yet applied">
              {edit.diff.before.map((line, index) => (
                <div className="pending-diff-line is-removed" key={`before-${index}`}>
                  <span className="mono">−</span>
                  <code className="mono">{line || ' '}</code>
                </div>
              ))}
              {edit.diff.after.map((line, index) => (
                <div className="pending-diff-line is-added" key={`after-${index}`}>
                  <span className="mono">+</span>
                  <code className="mono">{line || ' '}</code>
                </div>
              ))}
            </div>

            {(scores || reason) && (
              <div className="pending-verdict-detail">
                {scores && <span className="pending-scores mono">{scores}</span>}
                {reason && (
                  <p className="pending-reason" title={edit.d1.reason ?? undefined}>
                    {reason}
                  </p>
                )}
              </div>
            )}
            {edit.overrideBlastRadius && actionable && (
              <p className="pending-note is-override-note">
                <TriangleAlert size={11} />
                <span>
                  Blast-radius limit exceeded: applying executes this large removal with the limit
                  waived — the cap is the only gate you are overriding.
                </span>
              </p>
            )}

            {explanation && (
              <p className={cx('pending-note', edit.status === 'stale' && 'is-stale')}>
                {edit.status === 'stale' && <TriangleAlert size={11} />}
                <span>{explanation}</span>
              </p>
            )}

            {actionable && busyNote && (
              <p className="pending-note is-busy-note" role="status">
                {busyNote}
              </p>
            )}

            {actionable && (
              <div className="pending-actions">
                <button
                  type="button"
                  className="pending-act is-apply"
                  onClick={() => onApply(edit.id)}
                  disabled={busy}
                  aria-label={APPLY_LABEL}
                  title={busy && busyNote ? busyNote : 'Apply — hard gates re-run against the current note before anything is written'}
                >
                  <Check size={13} />
                  <span>Apply</span>
                </button>
                <button
                  type="button"
                  className="pending-act is-discard"
                  onClick={() => onDiscard(edit.id)}
                  disabled={busy}
                  aria-label={DISCARD_LABEL}
                  title={busy && busyNote ? busyNote : 'Discard — nothing is written; the proposal is logged'}
                >
                  <X size={13} />
                  <span>Discard</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  )
}
