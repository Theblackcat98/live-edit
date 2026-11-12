import { History } from 'lucide-react'
import type { ContextUsage } from '../../types'
import { modeDef } from '../../lib/modes'
import type { RunMode } from '../../lib/runmode'
import { cx } from '../../lib/utils'

function formatContext(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}K`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

/** Context budget, one row per model the active mode actually runs. */
export function ContextRows({
  usage,
  mode,
}: {
  usage: ContextUsage
  mode: RunMode
}) {
  // One row per model the mode actually runs, in registry roster order; limits
  // are the servers' real -c windows (start-models.sh). Each row's usage slot
  // is its roster model's flow — 'omni' stays the interface slot, whatever
  // model fills it.
  const def = modeDef(mode)
  const rows: Array<{
    id: string
    label: string
    limit: number
    value: number
    color: string
  }> = def.contextRows.map((row, index) => {
    const model = def.roster[index]
    return {
      id: model.flow,
      label: row.label,
      limit: row.limit,
      value: usage[model.flow],
      color: model.color,
    }
  })

  return (
    <section className="rail-card context-card">
      <header className="rail-header">
        <div className="rail-title">
          <History size={13} />
          Context budget
        </div>
        <span className="chip chip-ghost">
          {rows.length} {rows.length === 1 ? 'model' : 'models'}
        </span>
      </header>
      <div className="context-rows">
        {rows.map((row) => {
          const percent = Math.min(100, (row.value / row.limit) * 100)
          return (
            <div className="context-row" key={row.id}>
              <div className="context-row-head">
                <span className="context-label">
                  <span className={cx('status-dot', `is-${row.color}`)} />
                  {row.label}
                </span>
                <span className="context-values mono">
                  {formatContext(row.value)} <span>/ {formatContext(row.limit)}</span>
                </span>
              </div>
              <div className="context-bar">
                <span
                  className={cx('context-fill', `fill-${row.color}`)}
                  style={{ width: `${row.value > 0 ? Math.max(2, percent) : 0}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="context-foot mono">
        {rows.some((row) => row.value > 0)
          ? 'Last prompt size each server reported'
          : 'Not measured yet — fills in after the first turn'}
      </div>
    </section>
  )
}
