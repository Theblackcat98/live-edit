import { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  History,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import type {
  ContextUsage,
  RuntimeHealth,
  Snapshot,
  StageId,
  StageState,
  Trace,
} from '../types'
import type { RunMode } from '../lib/runmode'
import { cx, relativeTime } from '../lib/utils'
import { SafetyCheckCard } from './rail/SafetyCheckCard'
import { ContextRows } from './rail/ContextRows'
import { RuntimeWiringCard } from './rail/RuntimeWiringCard'
import { RuntimeCard } from './rail/RuntimeCard'

interface RuntimeRailProps {
  activeModel: 'omni' | 'd1' | 'worker' | null
  trace: Trace | null
  stageStates: Record<StageId, StageState>
  contextUsage: ContextUsage
  history: Snapshot[]
  historyIndex: number
  busy: boolean
  nowTick: number
  restoreSnapshot: (id: string) => void
  openTrace: () => void
  runtimeHealth: RuntimeHealth | null
  refreshRuntime: () => Promise<void>
  /** Active run mode, surfaced in the Runtime truth card. */
  mode: RunMode
  /** Switches the run mode; the runtime-card control is the phone surface's entry point. */
  onSetMode: (mode: RunMode) => void
  /** True when any run (current or persisted) can be opened in the trace drawer. */
  canOpenTrace: boolean
}

function SnapshotsCard({
  history,
  historyIndex,
  busy,
  nowTick,
  restoreSnapshot,
}: {
  history: Snapshot[]
  historyIndex: number
  busy: boolean
  nowTick: number
  restoreSnapshot: (id: string) => void
}) {
  const total = history.length
  const [showAll, setShowAll] = useState(false)
  const windowSize = showAll ? total : Math.min(3, total)
  let start = showAll ? 0 : Math.max(0, historyIndex - 1)
  if (!showAll && start + windowSize > total) start = Math.max(0, total - windowSize)
  const visible = history
    .map((snapshot, index) => ({ snapshot, index }))
    .slice(start, start + windowSize)
    .reverse()
  const canExpand = total > 3

  return (
    <section className="rail-card snapshots-card">
      <header className="rail-header">
        <div className="rail-title">
          <History size={13} />
          Snapshots
        </div>
        <span className="chip chip-ghost mono">#{historyIndex}</span>
      </header>
      <div className={cx('snapshot-list', showAll && 'is-expanded')}>
        {visible.map(({ snapshot, index }) => {
          const current = index === historyIndex
          const future = index > historyIndex
          return (
            <button
              key={snapshot.id}
              type="button"
              className={cx(
                'snapshot-row',
                current && 'is-current',
                future && 'is-future',
              )}
              onClick={() => restoreSnapshot(snapshot.id)}
              disabled={busy || current}
              title={current ? 'Current snapshot' : `Restore ${snapshot.label}`}
            >
              <span className={cx('snapshot-dot', current && 'is-current')} />
              <span className="snapshot-label">{snapshot.label}</span>
              <span className="snapshot-time mono">{relativeTime(snapshot.at, nowTick)}</span>
              {!current && <RotateCcw size={10} className="snapshot-restore" />}
            </button>
          )
        })}
      </div>
      {history.length === 1 && (
        <div className="snapshot-empty">
          Verified calls land here, one click from rollback.
        </div>
      )}
      {!showAll && canExpand && (
        <button
          type="button"
          className="snapshot-foot mono"
          onClick={() => setShowAll(true)}
          title="Show every snapshot"
        >
          Show all {total} snapshots
          <ChevronDown size={9} />
        </button>
      )}
      {showAll && canExpand && (
        <button
          type="button"
          className="snapshot-foot mono"
          onClick={() => setShowAll(false)}
          title="Return to the recent window"
        >
          Show recent
          <ChevronUp size={9} />
        </button>
      )}
    </section>
  )
}

export function RuntimeRail({
  activeModel,
  trace,
  stageStates,
  contextUsage,
  history,
  historyIndex,
  busy,
  nowTick,
  restoreSnapshot,
  openTrace,
  runtimeHealth,
  refreshRuntime,
  mode,
  onSetMode,
  canOpenTrace,
}: RuntimeRailProps) {
  return (
    <>
      <RuntimeCard activeModel={activeModel} runtimeHealth={runtimeHealth} mode={mode} />
      <RuntimeWiringCard
        runtimeHealth={runtimeHealth}
        refreshRuntime={refreshRuntime}
        trace={trace}
        mode={mode}
        onSetMode={onSetMode}
      />
      <SafetyCheckCard
        trace={trace}
        stageStates={stageStates}
        openTrace={openTrace}
        mode={mode}
        canOpenTrace={canOpenTrace}
      />
      <ContextRows usage={contextUsage} mode={mode} runtimeHealth={runtimeHealth} />
      <SnapshotsCard
        history={history}
        historyIndex={historyIndex}
        busy={busy}
        nowTick={nowTick}
        restoreSnapshot={restoreSnapshot}
      />
      <div className="rail-footnote">
        <ShieldCheck size={11} />
        LFM Open License v1.0 · local-first by design
      </div>
    </>
  )
}
