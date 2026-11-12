import type { RuntimeHealth } from '../../types'
import type { RunMode } from '../../lib/runmode'
import { cx } from '../../lib/utils'
import { modelHostLabel, usedByMode } from '../../lib/runView'

/**
 * The health-probe rows under Runtime truth: availability, not provenance.
 * Servers the active mode does not use are shown dimmed as "not used" — their
 * state is irrelevant to this mode and must not read as a failure.
 */
export function EndpointRows({ runtimeHealth, mode }: { runtimeHealth: RuntimeHealth | null; mode: RunMode }) {
  const endpoints = [...(runtimeHealth?.endpoints ?? [])].sort(
    (a, b) => Number(usedByMode(b.id, mode)) - Number(usedByMode(a.id, mode)),
  )
  return (
    <div className="wiring-endpoints">
      {endpoints.map((endpoint) => {
        const used = usedByMode(endpoint.id, mode)
        return (
          <div
            key={endpoint.id}
            className={cx('wiring-endpoint', !endpoint.up && 'is-down', !used && 'is-unused')}
            title={endpoint.error ?? endpoint.models?.join(', ')}
          >
            <span className={cx('status-dot', !used ? '' : endpoint.up ? 'is-green' : 'is-red')} />
            <span className="mono">{endpoint.port}</span>
            <span className="wiring-endpoint-name">{endpoint.name}</span>
            <span className="wiring-endpoint-meta mono">
              {!used
                ? 'not used in this mode'
                : endpoint.up
                  ? `${endpoint.latencyMs ?? 0} ms${endpoint.models?.length ? ` · ${endpoint.models[0]}` : ''}`
                  : 'down'}
            </span>
          </div>
        )
      })}
      {!runtimeHealth && (
        <div className="wiring-muted mono">Probing {modelHostLabel()} :8080 · :8083 · :8085 · :8086…</div>
      )}
    </div>
  )
}
