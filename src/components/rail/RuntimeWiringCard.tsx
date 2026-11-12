import { useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import type { RuntimeHealth, Trace } from '../../types'
import { modeDef } from '../../lib/modes'
import type { RunMode } from '../../lib/runmode'
import { cx } from '../../lib/utils'
import { ModeSwitch } from '../ModeSwitch'
import { EndpointRows } from './EndpointRows'

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
    // Who decides "edit or conversation": d1 in audio mode (turn_intent over
    // /v1/systemone), the front-door model's own tool call in legacy omni,
    // and nobody in the worker-chat modes (the 1.7B chats and calls tools).
    mode === 'audio'
      ? {
          id: 'route',
          label: 'Routing',
          target: 'd1-Omni-2B · turn_intent',
          endpoint: 'd1omni',
          fallback: 'd1 unreachable — treated as conversation',
        }
      : omniFirst
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
            target: 'no model route — the 1.7B calls tools itself',
            endpoint: null,
            fallback: '',
          },
    {
      id: 'worker',
      label: 'Worker call',
      target: 'LFM3-1.7B · authors + grounds the edit',
      endpoint: 'text',
      fallback: 'turn fails honestly — no template authoring',
    },
    d1Endpoint
      ? {
          id: 'critic',
          label: 'Safety check',
          target: 'd1-Omni-2B + hard gates',
          endpoint: d1Endpoint,
          fallback: 'd1 unavailable · held for your decision',
        }
      : {
          id: 'critic',
          label: 'Safety check',
          target: 'hard gates only — every edit held for you',
          endpoint: null,
          fallback: '',
        },
    { id: 'execute', label: 'Execution', target: 'in-tab diff engine', endpoint: null, fallback: '' },
  ]
}

/** What actually ran for one surface on the latest run, from trace.runtime. */
interface WiringVerdict {
  badge: 'LIVE' | 'FALLBACK' | 'ENGINE' | 'TYPED' | 'OFF' | 'IDLE' | 'SKIPPED' | 'DICTATED' | '—'
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
      if (stage === 'live') return { badge: 'LIVE', tone: 'live', detail: surface.target }
      // The stage never ran this turn (chat-only turn, stopped earlier).
      if (stage === 'skipped') return { badge: 'SKIPPED', tone: 'idle', detail: 'not needed this turn' }
      // Dictated text: the harness built the call from your exact words.
      if (stage === 'dictation')
        return { badge: 'DICTATED', tone: 'engine', detail: 'your exact words — harness-built call, no decode' }
      return { badge: 'FALLBACK', tone: 'fallback', detail: surface.fallback }
    }
  }
}

export function RuntimeWiringCard({
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

      <EndpointRows runtimeHealth={runtimeHealth} mode={mode} />
    </section>
  )
}
