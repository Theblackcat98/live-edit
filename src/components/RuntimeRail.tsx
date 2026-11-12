import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Cpu,
  History,
  LoaderCircle,
  Minus,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  ContextUsage,
  RuntimeHealth,
  Snapshot,
  StageId,
  StageState,
  Trace,
} from '../types'
import { rosterFor, rosterMemoryGB, MEMORY_BUDGET_GB } from '../data/models'
import { runModeInfo, chatModelName, transcribingModel, type RunMode } from '../lib/runmode'
import { cx, formatP, relativeTime } from '../lib/utils'
import { ModeSwitch } from './ModeSwitch'

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

function formatTiming(value: number | undefined): string {
  if (!value) return '—'
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
}

function toggleClass(state: StageState): string {
  return `is-${state}`
}

function StageIcon({ state }: { state: StageState }) {
  if (state === 'running') return <LoaderCircle size={11} className="spin" />
  if (state === 'done') return <Check size={11} />
  if (state === 'skipped') return <Minus size={11} />
  if (state === 'failed') return <X size={11} />
  return <Circle size={7} />
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
  const models = rosterFor(mode)
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
          Model roster · {runModeInfo(mode).short}
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
 * What each surface is wired to in the active mode. Targets name the model
 * that actually serves the mode — Audio by default, Omni only in legacy.
 */
function wiringSurfacesFor(mode: RunMode): WiringSurface[] {
  const chat = chatModelName(mode)
  const asrModel = transcribingModel(mode)
  const frontDoor: 'audio' | 'omni' = mode === 'omni' ? 'omni' : 'audio'
  const d1Endpoint: 'd1omni' | null = mode === 'lowram' ? null : 'd1omni'
  return [
    asrModel
      ? {
          id: 'asr',
          label: 'Voice ASR',
          target: `${asrModel} /v1/audio/transcriptions`,
          endpoint: mode === 'worker-d1' ? 'd1omni' : frontDoor,
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
      target: `${chat} /v1/chat/completions`,
      endpoint: mode === 'audio' ? 'audio' : mode === 'omni' ? 'omni' : 'text',
      fallback: 'turn fails honestly — no canned replies',
    },
    mode === 'audio' || mode === 'omni'
      ? {
          id: 'route',
          label: 'Routing',
          target: `${chat} · typed directive`,
          endpoint: frontDoor,
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
  const modeInfo = runModeInfo(mode)
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

function Stage({
  letter,
  title,
  state,
  timing,
  children,
  last,
}: {
  letter: StageId
  title: string
  state: StageState
  timing?: number
  children: ReactNode
  last?: boolean
}) {
  return (
    <div className={cx('sup-stage', toggleClass(state), last && 'is-last')}>
      <div className="sup-stage-track">
        <span className="sup-stage-node">
          <span className="sup-stage-letter mono">{letter}</span>
          <span className="sup-stage-state">
            <StageIcon state={state} />
          </span>
        </span>
        {!last && <span className="sup-stage-line" />}
      </div>
      <div className="sup-stage-main">
        <div className="sup-stage-head">
          <span className="sup-stage-title mono">{title}</span>
          <span className="sup-stage-time mono">{formatTiming(timing)}</span>
        </div>
        <div className="sup-stage-body">{children}</div>
      </div>
    </div>
  )
}

function SupervisorCard({
  trace,
  stageStates,
  openTrace,
}: {
  trace: Trace | null
  stageStates: Record<StageId, StageState>
  openTrace: () => void
}) {
  const route = trace?.route
  const critic = trace?.critic
  const actionTone =
    route?.action === 'file_mutation'
      ? 'chip-accent'
      : route?.action === 'ambiguous_request'
        ? 'chip-orange'
        : 'chip-green'
  const running = Object.values(stageStates).some((state) => state === 'running')

  return (
    <section className="rail-card supervisor-card">
      <header className="rail-header">
        <div className="rail-title">
          <ScanSearch size={13} />
          Supervisor
          <span className={cx('status-dot', running ? 'is-accent is-pulsing' : 'is-accent')} />
        </div>
        <span
          className="chip chip-ghost mono"
          title={
            trace && (trace.runtime?.worker === 'live' || trace.runtime?.chat === 'live')
              ? 'token usage reported by the model server'
              : 'estimated from local text — no model decode reported usage'
          }
        >
          {trace?.outputTokens
            ? `${
                trace.runtime?.worker === 'live' || trace.runtime?.chat === 'live' ? '' : '≈'
              }${trace.outputTokens} output tokens`
            : '0 output tokens'}
        </span>
      </header>
      <div className="supervisor-model mono">d1-Omni-2B · 128K · Q8_0 · single pass</div>

      <div className="sup-stages">
        <Stage
          letter="A"
          title="ROUTE"
          state={stageStates.A}
          timing={trace?.timings.route}
        >
          {route ? (
            <div className="sup-stage-data">
              <div className="sup-chip-row">
                <span className={cx('chip', actionTone)}>{route.action.replace(/_/g, ' ')}</span>
                <span
                  className="chip chip-ghost mono"
                  title="measured by d1 · heuristic (local) · — unreported"
                >
                  P {formatP(route.actionConfidence)}
                </span>
              </div>
              {route.allowedTools.length > 0 && (
                <div className="sup-tools">
                  {route.allowedTools.slice(0, 2).map((tool) => (
                    <span key={tool.name} className="sup-tool mono">
                      {tool.name}
                      <span>{formatP(tool.p)}</span>
                    </span>
                  ))}
                </div>
              )}
              <span className="sup-muted mono">
                {route.actionConfidence === null && route.allowedTools.every((tool) => tool.p === null)
                  ? 'unreported'
                  : trace?.runtime?.route === 'live'
                    ? 'measured by d1'
                    : 'local heuristic'}
              </span>
            </div>
          ) : stageStates.A === 'running' ? (
            <span className="sup-running">Classifying action_required…</span>
          ) : stageStates.A === 'skipped' ? (
            <span className="sup-muted">No routing pass for this turn.</span>
          ) : (
            <span className="sup-muted">Awaiting a command · heads armed</span>
          )}
        </Stage>

        <Stage
          letter="B"
          title="GROUND"
          state={stageStates.B}
          timing={trace?.timings.ground}
        >
          {stageStates.B === 'running' ? (
            <span className="sup-running">Extracting span…</span>
          ) : stageStates.B === 'skipped' ? (
            <span className="sup-muted">No span needed for this turn.</span>
          ) : (
            <span className="sup-muted">Span head idle</span>
          )}
        </Stage>

        <Stage
          letter="C"
          title="VERIFY"
          state={stageStates.C}
          timing={trace?.timings.critic}
          last
        >
          {critic ? (
            <div className="sup-stage-data">
              <div className="sup-prob-row">
                <span className="sup-prob">
                  <span className="mono">P(correct)</span>
                  <strong className="mono">{formatP(critic.pCorrect)}</strong>
                </span>
                <span className="sup-prob">
                  <span className="mono">safe</span>
                  <strong className="mono">{formatP(critic.pSafe)}</strong>
                </span>
                <span
                  className={cx(
                    'chip',
                    critic.verdict === 'verified' ? 'chip-green' : 'chip-red',
                  )}
                >
                  {critic.verdict === 'verified' ? 'verified' : 'held'}
                </span>
              </div>
              <div className="sup-checks mono">
                {critic.checks.filter((check) => check.pass).length}/{critic.checks.length} checks pass
              </div>
              <span className="sup-muted mono">
                {critic.pCorrect === null
                  ? 'local gates only · p unreported'
                  : 'p measured by d1'}
              </span>
            </div>
          ) : stageStates.C === 'running' ? (
            <span className="sup-running">Scoring proposed XML call…</span>
          ) : stageStates.C === 'skipped' ? (
            <span className="sup-muted">Critic bypassed — no worker call.</span>
          ) : (
            <span className="sup-muted">Critic armed · local hard gates</span>
          )}
        </Stage>
      </div>

      <button
        type="button"
        className="supervisor-trace-button"
        onClick={openTrace}
        disabled={!trace}
      >
        Open decision trace
        <ArrowUpRight size={11} />
      </button>
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
  // One row per model the mode actually runs; limits are the servers' real
  // -c windows (start-models.sh). The interface row id stays 'omni' — it is
  // the interface slot of ContextUsage, whatever model fills it.
  const rows: Array<{
    id: string
    label: string
    limit: number
    value: number
    color: string
  }> =
    mode === 'audio' || mode === 'omni'
      ? [
          {
            id: 'omni',
            label: mode === 'audio' ? 'Audio · rolling' : 'Omni · rolling',
            limit: mode === 'audio' ? 128000 : 32000,
            value: usage.omni,
            color: 'green',
          },
          { id: 'd1', label: 'd1 · stateless', limit: 128000, value: usage.d1, color: 'accent' },
          { id: 'worker', label: '1.7B · task', limit: 128000, value: usage.worker, color: 'orange' },
        ]
      : mode === 'worker-d1'
        ? [
            { id: 'worker', label: '1.7B · chat + calls', limit: 128000, value: usage.worker, color: 'orange' },
            { id: 'd1', label: 'd1 · stateless', limit: 128000, value: usage.d1, color: 'accent' },
          ]
        : [{ id: 'worker', label: '1.7B · rolling', limit: 128000, value: usage.worker, color: 'orange' }]


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
      <SupervisorCard trace={trace} stageStates={stageStates} openTrace={openTrace} />
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
