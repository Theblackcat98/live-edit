import { CircleAlert, X } from 'lucide-react'
import type { Trace } from '../../types'
import { D1_THRESHOLDS } from '../../lib/d1check'
import { humanD1Reason } from '../../lib/d1reason'
import { cx } from '../../lib/utils'

/**
 * The d1 verdict card. Rendered only for a check that did not approve — an
 * approved call proceeds and needs no warning. Each typed question becomes a
 * bar that shows exactly what d1 reported: numeric questions (match, clarity,
 * confidence) draw their measured score against the approval threshold;
 * choice questions (safety, target support) draw their state — full for a
 * definite answer, never a number d1 never gave. Unreported stays empty and
 * says so (runtime honesty — design.md §2.7).
 */

type Tone = 'pass' | 'fail' | 'unreported'

interface BarRow {
  key: string
  label: string
  /** Numeric rows: the measured score (0–1). Choice rows carry no number. */
  value: number | null
  /** Numeric rows: the approval threshold tick. */
  threshold: number | null
  /** What the row reads as — the bar's fill and value text come from these. */
  tone: Tone
  /** Choice rows: the state word ('safe', 'unsupported', …). */
  word: string | null
}

function numericRow(key: string, label: string, value: number | null, threshold: number): BarRow {
  if (value === null) return { key, label, value: null, threshold: null, tone: 'unreported', word: null }
  return { key, label, value, threshold, tone: value >= threshold ? 'pass' : 'fail', word: null }
}

function choiceRow(
  key: string,
  label: string,
  state: 'supported' | 'unsupported' | 'safe' | 'unintended_data_loss' | null,
): BarRow {
  if (state === null) return { key, label, value: null, threshold: null, tone: 'unreported', word: null }
  const good = state === 'supported' || state === 'safe'
  return {
    key,
    label,
    value: null,
    threshold: null,
    tone: good ? 'pass' : 'fail',
    word: state === 'unintended_data_loss' ? 'unintended data loss' : state,
  }
}

export function D1CheckSection({ check }: { check: NonNullable<Trace['d1Check']> }) {
  if (check.verdict === 'approved') return null
  const unavailable = check.verdict === 'unavailable'
  const rows: BarRow[] = [
    numericRow('match', 'match', check.noul, D1_THRESHOLDS.noulApprove),
    numericRow('clarity', 'clarity', check.intentClarity, D1_THRESHOLDS.clarityApprove),
    numericRow('confidence', 'confidence', check.executionConfidence, D1_THRESHOLDS.confidenceApprove),
    choiceRow('target', 'target support', check.targetSupport),
    choiceRow('safety', 'safety', check.destructiveSafety),
  ]
  const human = humanD1Reason(check)

  return (
    <div className={cx('trace-verdict', unavailable && 'is-unavailable')}>
      <div className="trace-verdict-head">
        <span className="trace-verdict-icon" aria-hidden="true">
          {unavailable ? <CircleAlert size={11} /> : <X size={11} />}
        </span>
        <strong>
          {unavailable
            ? 'Safety check unavailable — held for your decision'
            : 'Safety check disapproved — held for your decision'}
        </strong>
      </div>
      {human && <p className="trace-verdict-reason">{human}</p>}
      <div className="trace-verdict-bars" aria-label="d1 scores by question">
        {rows.map((row) => (
          <div className={cx('trace-verdict-bar', `is-${row.tone}`)} key={row.key}>
            <span className="trace-verdict-bar-label mono">{row.label}</span>
            <span className="trace-verdict-bar-track" aria-hidden="true">
              {row.value !== null ? (
                <span
                  className="trace-verdict-bar-fill"
                  style={{ width: `${Math.min(100, Math.max(0, row.value * 100))}%` }}
                />
              ) : (
                row.word && <span className="trace-verdict-bar-fill is-full" />
              )}
              {row.threshold !== null && (
                <span
                  className="trace-verdict-bar-tick"
                  style={{ left: `${row.threshold * 100}%` }}
                />
              )}
            </span>
            <span className="trace-verdict-bar-value mono">
              {row.value !== null
                ? row.value.toFixed(2)
                : row.word ?? 'unreported'}
            </span>
          </div>
        ))}
      </div>
      <span className="trace-verdict-meta mono">
        pending edit · note untouched{check.reason ? ` · raw: ${check.reason}` : ''}
      </span>
    </div>
  )
}
