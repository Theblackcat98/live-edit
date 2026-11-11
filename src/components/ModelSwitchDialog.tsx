import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { ENDPOINTS } from '../lib/bridge'
import { runModeInfo, type RunMode } from '../lib/runmode'
import type { EndpointId, ModelSwitchPlan } from '../lib/modelPlan'

interface ModelSwitchDialogProps {
  /** The switch waiting for confirmation: what it starts, what it leaves. */
  plan: ModelSwitchPlan
  /** Current mode — names the cancel action honestly. */
  from: RunMode
  /** True while models start/stop and health polls; locks every control. */
  switching: boolean
  onConfirm: (stopSpares: boolean) => void
  onCancel: () => void
}

function endpointLabel(id: EndpointId): string {
  const endpoint = ENDPOINTS.find((entry) => entry.id === id)
  return endpoint ? `${endpoint.name} · :${endpoint.port}` : id
}

/**
 * The mode-switch confirmation (model-manager daemon present): names the
 * members it will start, and makes stopping already-loaded spares opt-in.
 * Without the daemon this dialog never appears — the switch just lands.
 */
export function ModelSwitchDialog({ plan, from, switching, onConfirm, onCancel }: ModelSwitchDialogProps) {
  const [stopSpares, setStopSpares] = useState(false)
  const target = runModeInfo(plan.mode)
  const current = runModeInfo(from)

  const content = (
    <div className="model-switch-overlay">
      <div className="model-switch-backdrop" onClick={switching ? undefined : onCancel} aria-hidden="true" />
      <section className="model-switch-dialog" role="dialog" aria-modal="true" aria-label="Switch run mode">
        <header className="model-switch-header">
          <h2>Switch to {target.short}?</h2>
          <p>{target.description}</p>
        </header>

        <div className="model-switch-body">
          {plan.toStart.length > 0 && (
            <section>
              <h3>
                {plan.toStart.length > 1 ? 'These models are' : 'This model is'} not answering —{' '}
                {target.short} needs {plan.toStart.length > 1 ? 'them' : 'it'}
              </h3>
              <ul className="model-switch-list">
                {plan.toStart.map((id) => (
                  <li key={id}>
                    <span className="model-switch-name">{endpointLabel(id)}</span>
                    <span className="model-switch-state">start now</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.spareLoaded.length > 0 && (
            <section>
              <h3>Running, but {target.short} does not use {plan.spareLoaded.length > 1 ? 'them' : 'it'}</h3>
              <ul className="model-switch-list">
                {plan.spareLoaded.map((id) => (
                  <li key={id}>
                    <span className="model-switch-name">{endpointLabel(id)}</span>
                    <span className="model-switch-state">loaded</span>
                  </li>
                ))}
              </ul>
              <label className="model-switch-check">
                <input
                  type="checkbox"
                  checked={stopSpares}
                  onChange={(event) => setStopSpares(event.target.checked)}
                  disabled={switching}
                />
                <span>
                  Stop {plan.spareLoaded.length > 1 ? 'them' : 'it'} to free memory — restart later by switching
                  back
                </span>
              </label>
            </section>
          )}
        </div>

        <footer className="model-switch-actions">
          {switching ? (
            <p className="model-switch-progress">
              <Loader2 size={13} aria-hidden="true" />
              Starting models — d1-Omni can take a minute to load. The switch lands when they answer.
            </p>
          ) : (
            <>
              <button type="button" className="button button-quiet" onClick={onCancel}>
                Stay on {current.short}
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => onConfirm(stopSpares)}
              >
                Switch{plan.toStart.length > 0 ? ' & start' : ''}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  )

  return createPortal(content, document.body)
}
