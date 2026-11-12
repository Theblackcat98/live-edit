import { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Cpu,
  History,
  RefreshCw,
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
import { rosterMemoryGB, MEMORY_BUDGET_GB } from '../data/models'
import { modeDef } from '../lib/modes'
import type { RunMode } from '../lib/runmode'
import { cx, relativeTime } from '../lib/utils'
import { ModeSwitch } from './ModeSwitch'
import { SafetyCheckCard } from './rail/SafetyCheckCard'

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
}

function formatContext(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}K`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

function RuntimeCard({
  activeModel,
  runtimeHealth,
  mode,
}: {
  activeModel: RuntimeRailProps['activeModel']
  runtimeHealth: RuntimeHealth | null
  mode: RunMode
}) {
  const models = modeDef(mode).roster
  const rosterMemory = rosterMemoryGB(models)
  const upCount = runtimeHealth
    ? runtimeHealth.endpoints.filter((endpoint) => endpoint.up).length
    : null
  const allUp = upCount !== null && upCount === runtimeHealth?.endpoints.length
  return (
    <section className="rail-card runtime-card">
      <header className="rail-header">
        <div className="rail-title">
          <Cpu size={13} />
          Model roster · {modeDef(mode).info.short}
        </div>
        <span
          className={cx(
            'chip',
            !runtimeHealth ? 'chip-ghost' : allUp ? 'chip-green' : 'chip-orange',
          )}
          title={
            runtimeHealth
              ? `${upCount}/${runtimeHealth.endpoints.length} local model servers answering on 127.0.0.1`
              : 'Probing local model servers…'
          }
        >
          {runtimeHealth ? `${allUp ? 'LIVE' : `${upCount}/${runtimeHealth.endpoints.length} up`}` : '…'}
        </span>
      </header>

      <div className="runtime-list">
        {models.map((model) => {
          // 'omni' is the interface slot on the flow rail whatever the model.
          const active = model.flow === activeModel
          return (
            <div
              key={model.id}
              className={cx('model-row', active && 'is-active')}
              title={model.description}
            >
              <span className={cx('status-dot', `is-${model.color}`, active && 'is-pulsing')} />
              <div className="model-main">
                <div className="model-row-top">
                  <span className="model-short">{model.shortName}</span>
                  <span className={cx('model-role mono', `role-${model.color}`)}>
                    {model.role}
                  </span>
                </div>
                <div className="model-name mono">{model.name}</div>
              </div>
              <div className="model-meta">
                <span className="model-mem mono">{model.memGB.toFixed(1)} GB</span>
                <span className="model-ctx mono">{model.contextK}K · {model.quant}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="runtime-memory">
        <div className="runtime-memory-label">
          <span>Unified memory</span>
          <span className="mono">
            {rosterMemory.toFixed(1)} / {MEMORY_BUDGET_GB.toFixed(1)} GB
          </span>
        </div>
        <div className="runtime-memory-bar" aria-hidden="true">
          {models.map((model) => (
            <span
              key={model.id}
              className={`memory-segment segment-${model.color}`}
              style={{ width: `${(model.memGB / MEMORY_BUDGET_GB) * 100}%` }}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

interface WiringSurface {
  id: string
  label: string
  target: string
  endpoint: 'omni' | 'audio' | 'd1omni' | 'text' | null
  fallback: string
  /** Surface is absent in this mode (e.g. ASR in lowram) — shown as OFF. */
  off?: true
}

/**
 * What each surface is wired to in the active mode, straight from the mode's
 * registry row: the chat author/endpoint, the speech endpoint and the decision
 * policy. Targets name the model that actually serves the mode — Audio by
 * default, Omni only in legacy.
 */
function wiringSurfacesFor(mode: RunMode): WiringSurface[] {
  const def = modeDef(mode)
  const { chat } = def
  const asrModel = chat.transcriber
  // Omni-first modes chat through a front-door model (Audio or legacy Omni);
  // the worker-chat flows chat through the 1.7B itself.
  const omniFirst = def.flow === 'omni-first'
  const d1Endpoint: 'd1omni' | null = def.decide === 'd1' ? 'd1omni' : null
  return [
    asrModel
      ? {
          id: 'asr',
          label: 'Voice ASR',
          target: `${asrModel} /v1/audio/transcriptions`,
          endpoint: def.speech,
          fallback: 'typed input instead',
        }
      : {
          id: 'asr',
          label: 'Voice ASR',
          target: 'off — no audio server in this mode',
          endpoint: null,
          fallback: '',
          off: true,
        },
    {
      id: 'chat',
      label: 'Chat replies',
      target: `${chat.author} /v1/chat/completions`,
      endpoint: chat.endpoint,
      fallback: 'turn fails honestly — no canned replies',
    },
    omniFirst
      ? {
          id: 'route',
          label: 'Routing',
          target: `${chat.author} · typed directive`,
          endpoint: def.speech,
          fallback: 'turn fails honestly — no heuristic router',
        }
      : {
          id: 'route',
          label: 'Routing',
          target: 'deterministic undo/redo pre-check — no model route',
          endpoint: null,
          fallback: '',
        },
    {
      id: 'ground',
      label: 'Span grounding',
      target: 'LFM3-1.7B grounds its own span',
      endpoint: null,
      fallback: '',
    },
    {
      id: 'worker',
      label: 'Worker call',
      target: 'LFM3-1.7B /v1/chat/completions',
      endpoint: 'text',
      fallback: 'turn fails honestly — no template authoring',
    },
    d1Endpoint
      ? {
          id: 'critic',
          label: 'Critic',
          target: 'd1-Omni + local gates',
          endpoint: d1Endpoint,
          fallback: 'local gates only · held as a pending edit',
        }
      : {
          id: 'critic',
          label: 'Critic',
          target: 'local gates + engine dry-run — no d1 in this mode',
          endpoint: null,
          fallback: '',
        },
    { id: 'execute', label: 'Execution', target: 'in-tab diff engine', endpoint: null, fallback: '' },
  ]
}

/** What actually ran for one surface on the latest run, from trace.runtime. */
interface WiringVerdict {
  badge: 'LIVE' | 'FALLBACK' | 'ENGINE' | 'TYPED' | 'OFF' | 'IDLE' | '—'
  tone: 'live' | 'fallback' | 'engine' | 'idle'
  detail: string
}

function wiringVerdict(surface: WiringSurface, trace: Trace | null): WiringVerdict {
  // Off in this mode (ASR in lowram): never dressed up as engine or fallback.
  if (surface.off) return { badge: 'OFF', tone: 'idle', detail: surface.target }
  // Execution is deterministic code — never a model call, on any run.
  if (!surface.endpoint) return { badge: 'ENGINE', tone: 'engine', detail: surface.target }
  // No run yet: say so instead of dressing the health probe up as provenance.
  if (!trace?.runtime) return { badge: 'IDLE', tone: 'idle', detail: 'no run yet this session' }

  switch (surface.id) {
    case 'asr':
      // asr is only recorded for spoken commands; a typed turn never called it.
      if (trace.runtime.asr === undefined)
        return { badge: 'TYPED', tone: 'engine', detail: 'typed command — no ASR call' }
      return trace.runtime.asr === 'live'
        ? { badge: 'LIVE', tone: 'live', detail: surface.target }
        : { badge: 'FALLBACK', tone: 'fallback', detail: surface.fallback }
    default: {
      const stage = trace.runtime[surface.id as 'route' | 'worker' | 'critic' | 'chat']
      return stage === 'live'
        ? { badge: 'LIVE', tone: 'live', detail: surface.target }
        : { badge: 'FALLBACK', tone: 'fallback', detail: surface.fallback }
    }
  }
}

function RuntimeWiringCard({
  runtimeHealth,
  refreshRuntime,
  trace,
  mode,
  onSetMode,
}: {
  runtimeHealth: RuntimeHealth | null
  refreshRuntime: () => Promise<void>
  trace: Trace | null
  mode: RunMode
  onSetMode: (mode: RunMode) => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const modeInfo = modeDef(mode).info
  const surfaces = wiringSurfacesFor(mode)
  const up = (id: 'omni' | 'audio' | 'd1omni' | 'text'): boolean =>
    runtimeHealth?.endpoints.some((endpoint) => endpoint.id === id && endpoint.up) ?? false

  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void refreshRuntime().finally(() => setRefreshing(false))
  }

  // Which endpoints the models actually ran against for the selected run.
  return (
    <section className="rail-card wiring-card">
      <header className="rail-header">
        <div className="rail-title">
          <ShieldCheck size={13} />
          Runtime truth
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Re-probe model endpoints"
          title="Re-probe model endpoints"
        >
          <RefreshCw size={11} className={cx(refreshing && 'spin')} />
        </button>
      </header>

      <div className="wiring-rows">
        <div className="wiring-row" title={modeInfo.description}>
          <span className="wiring-badge is-engine">MODE</span>
          <span className="wiring-label">Run mode</span>
          <span className="wiring-target mono">{modeInfo.label}</span>
        </div>
        {/* Phone surface (TopBar's control is hidden there): the same
            three-state switch, wired to the same setMode. */}
        <div className="wiring-mode-row">
          <ModeSwitch
            mode={mode}
            onSetMode={onSetMode}
            testId="mode-switch-runtime"
            buttonTestIdPrefix="mode-rt"
            className="runtime-mode-switch"
          />
        </div>
        {surfaces.map((surface) => {
          const verdict = wiringVerdict(surface, trace)
          // The health probe is real data, but it is availability — not what
          // ran. It rides along as a dot; the badge stays per-run provenance.
          const probeUp = surface.endpoint ? up(surface.endpoint) : null
          return (
            <div
              key={surface.id}
              className="wiring-row"
              title={`${verdict.badge} · ${verdict.detail}${
                probeUp === null ? '' : ` · endpoint probe: ${probeUp ? 'up' : 'down'}`
              }`}
            >
              <span className={cx('wiring-badge', `is-${verdict.tone}`)}>{verdict.badge}</span>
              <span className="wiring-label">{surface.label}</span>
              <span className="wiring-target mono">
                {surface.endpoint && (
                  <span
                    className={cx('status-dot', probeUp ? 'is-green' : 'is-red')}
                    title={`endpoint probe: ${probeUp ? 'up' : 'down'}`}
                  />
                )}
                {verdict.detail}
              </span>
            </div>
          )
        })}
      </div>

      <div className="wiring-endpoints">
        {(runtimeHealth?.endpoints ?? []).map((endpoint) => (
          <div
            key={endpoint.id}
            className={cx('wiring-endpoint', !endpoint.up && 'is-down')}
            title={endpoint.error ?? endpoint.models?.join(', ')}
          >
            <span className={cx('status-dot', endpoint.up ? 'is-green' : 'is-red')} />
            <span className="mono">{endpoint.port}</span>
            <span className="wiring-endpoint-name">{endpoint.name}</span>
            <span className="wiring-endpoint-meta mono">
              {endpoint.up
                ? `${endpoint.latencyMs ?? 0} ms${endpoint.models?.length ? ` · ${endpoint.models[0]}` : ''}`
                : 'down'}
            </span>
          </div>
        ))}
        {!runtimeHealth && <div className="wiring-muted mono">Probing 127.0.0.1 :8080 · :8083 · :8085 · :8086…</div>}
      </div>
    </section>
  )
}

function ContextCard({
  usage,
  trace,
  mode,
}: {
  usage: ContextUsage
  trace: Trace | null
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
        <span className="chip chip-ghost">{rows.length} {rows.length === 1 ? 'view' : 'views'}</span>
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
                  style={{ width: `${Math.max(2, percent)}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="context-foot mono">
        30s audio ring · ToC cached
        {trace?.promptTokens ? ` · ${formatContext(trace.promptTokens)} prompt` : ''}
      </div>
    </section>
  )
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
      <SafetyCheckCard trace={trace} stageStates={stageStates} openTrace={openTrace} />
      <ContextCard usage={contextUsage} trace={trace} mode={mode} />
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
