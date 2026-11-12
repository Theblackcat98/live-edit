import type { D1CheckResult } from '../../types'
import { D1_THRESHOLDS } from '../../lib/d1check'
import { humanD1Reason } from '../../lib/d1reason'
import { cx } from '../../lib/utils'
import { TraceSection } from './TraceSection'
import { ScoreBar, type ScoreTone } from './ScoreBar'

/**
 * The d1 safety check, for every verdict. Numeric questions (match, clarity,
 * confidence) draw their measured score against the approval threshold.
 * Choice questions (target support, safety) draw the probability d1 gave its
 * chosen answer when it reported one; otherwise the bar is full and only the
 * word is shown. Unreported stays an empty track (design.md §2.7).
 */

interface Row {
  key: string
  label: string
  value: number | null
  threshold: number | null
  tone: ScoreTone
  text?: string
}

function numericRow(key: string, label: string, value: number | null, threshold: number): Row {
  if (value === null) return { key, label, value: null, threshold: null, tone: 'unreported' }
  return { key, label, value, threshold, tone: value >= threshold ? 'pass' : 'fail' }
}

function choiceRow(
  key: string,
  label: string,
  choice: string | null,
  good: string,
  probabilities: Record<string, number> | undefined,
): Row {
  if (choice === null) return { key, label, value: null, threshold: null, tone: 'unreported' }
  const p = probabilities?.[choice]
  const word = choice === 'unintended_data_loss' ? 'data loss' : choice.replace(/_/g, ' ')
  return {
    key,
    label,
    value: typeof p === 'number' ? p : 1,
    threshold: null,
    tone: choice === good ? 'pass' : 'fail',
    text: typeof p === 'number' ? `${word} ${p.toFixed(2)}` : word,
  }
}

const VERDICT_CHIP: Record<D1CheckResult['verdict'], { label: string; tone: string }> = {
  approved: { label: 'approved', tone: 'chip-green' },
  disapproved: { label: 'disapproved', tone: 'chip-red' },
  unavailable: { label: 'unavailable', tone: 'chip-orange' },
}

export function D1CheckSection({ check }: { check: D1CheckResult }) {
  const rows: Row[] = [
    numericRow('match', 'matches brief', check.noul, D1_THRESHOLDS.noulApprove),
    numericRow('clarity', 'intent clarity', check.intentClarity, D1_THRESHOLDS.clarityApprove),
    numericRow('confidence', 'will execute', check.executionConfidence, D1_THRESHOLDS.confidenceApprove),
    choiceRow('target', 'target exists', check.targetSupport, 'supported', check.probabilities?.targetSupport),
    choiceRow('safety', 'no data loss', check.destructiveSafety, 'safe', check.probabilities?.destructiveSafety),
  ]
  const human = check.verdict === 'approved' ? null : humanD1Reason(check)
  const chip = VERDICT_CHIP[check.verdict]
  const caption = [
    'd1-Omni-2B',
    check.ms !== undefined ? `${Math.round(check.ms)} ms` : null,
    check.promptTokens ? `${check.promptTokens} prompt tok` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <TraceSection index="S" title="Safety check" caption={caption}>
      <div className="trace-check-head">
        <span className={cx('chip', chip.tone)}>{chip.label}</span>
        {human && <p className="trace-body">{human}</p>}
      </div>
      <div className="trace-kv trace-kv-bars" aria-label="d1 answers by question">
        {rows.map((row) => (
          <div className="trace-kv-row" key={row.key}>
            <span className="trace-kv-key">{row.label}</span>
            <span className="trace-kv-value">
              <ScoreBar value={row.value} threshold={row.threshold} tone={row.tone} text={row.text} />
            </span>
          </div>
        ))}
      </div>
      <p className="trace-footnote">Tick = approval threshold. Every question must pass for the edit to run on its own.</p>
      {check.reason && (
        <details className="trace-raw">
          <summary>Raw verdict</summary>
          <pre className="mono">{check.reason}</pre>
        </details>
      )}
    </TraceSection>
  )
}
