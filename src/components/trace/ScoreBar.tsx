import { cx } from '../../lib/utils'

export type ScoreTone = 'pass' | 'fail' | 'unreported'

/**
 * One 0–1 measurement drawn as a bar, with an optional threshold tick and
 * the value (or a word) beside it. `null` draws an empty track that says
 * "unreported" — never a number nobody measured.
 */
export function ScoreBar({
  value,
  threshold = null,
  tone,
  text,
}: {
  value: number | null
  threshold?: number | null
  tone: ScoreTone
  /** Overrides the numeric label (e.g. "safe · 0.97"). */
  text?: string
}) {
  const label = text ?? (value === null ? 'unreported' : value.toFixed(2))
  return (
    <span className={cx('score-bar', `is-${tone}`)}>
      <span className="score-bar-track" aria-hidden="true">
        {value !== null && (
          <span
            className="score-bar-fill"
            style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
          />
        )}
        {threshold !== null && (
          <span
            className="score-bar-tick"
            style={{ left: `${threshold * 100}%` }}
            title={`threshold ${threshold.toFixed(2)}`}
          />
        )}
      </span>
      <span className="score-bar-value mono">{label}</span>
    </span>
  )
}
