import type { RuntimeHealth } from '../../types'
import { cx } from '../../lib/utils'

/** The health-probe rows under Runtime truth: availability, not provenance. */
export function EndpointRows({ runtimeHealth }: { runtimeHealth: RuntimeHealth | null }) {
  return (
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
  )
}
