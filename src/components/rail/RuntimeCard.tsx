import { Cpu } from 'lucide-react'
import type { RuntimeHealth } from '../../types'
import { rosterMemoryGB, MEMORY_BUDGET_GB } from '../../data/models'
import { modeDef } from '../../lib/modes'
import type { RunMode } from '../../lib/runmode'
import { cx } from '../../lib/utils'
import { modeHealth, modelHostLabel } from '../../lib/runView'

/** The model roster and the unified-memory budget it fits in. */
export function RuntimeCard({
  activeModel,
  runtimeHealth,
  mode,
}: {
  activeModel: 'omni' | 'd1' | 'worker' | null
  runtimeHealth: RuntimeHealth | null
  mode: RunMode
}) {
  const models = modeDef(mode).roster
  const rosterMemory = rosterMemoryGB(models)
  const health = modeHealth(runtimeHealth, mode)
  return (
    <section className="rail-card runtime-card">
      <header className="rail-header">
        <div className="rail-title">
          <Cpu size={13} />
          Model roster · {modeDef(mode).info.short}
        </div>
        <span
          className={cx('chip', !health ? 'chip-ghost' : health.allUp ? 'chip-green' : 'chip-orange')}
          title={
            health
              ? `${health.up}/${health.needed.length} of this mode's model servers answering on ${modelHostLabel()}`
              : 'Probing local model servers…'
          }
        >
          {health ? (health.allUp ? 'all up' : `${health.up}/${health.needed.length} up`) : '…'}
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
