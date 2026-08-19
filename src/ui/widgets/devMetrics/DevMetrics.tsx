// FleetPulse — developer observability panel (FR-30, AD-5, AD-6, AD-8)
//
// Reads only from `obs.transportCounters` — a thin, already-declared
// passthrough (`obsSlice.ts`) that `app/bootstrap.ts`'s existing periodic
// tick (the same one already polling the circuit breaker's state, story 9)
// now also populates from `sse-manager`'s `getDroppedMessageCount()`/
// `getReconnectCount()`/`getEventsPerSecond()` and `ws-manager`'s
// `getDroppedMessageCount()`/`getReconnectCount()`/`getLastPingRttMs()`
// (Boundaries & Constraints). This widget subscribes to that store slice
// exactly the way every other widget subscribes to its own data — no new
// fetch, no new subscription path, no timer of its own.
//
// Not part of the dispatcher mutation workflow (FR-30's own text) — purely
// a read-only display, same as `AnomalyView`.

import { getFleetPulseStore } from '../../../store/store.ts'
import { registerWidget } from '../../registry.ts'
import styles from './DevMetrics.module.css'

const useFleetPulseStore = getFleetPulseStore()

interface MetricProps {
  label: string
  value: string
  testId: string
}

function Metric({ label, value, testId }: MetricProps) {
  return (
    <div className={styles.metric}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value} data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}

export function DevMetrics() {
  // Field-access selector — `transportCounters` is only replaced on an
  // actual `setTransportCounters` patch (obsSlice.ts), same referential-
  // stability convention every other widget's store subscription relies on.
  const counters = useFleetPulseStore((state) => state.obs.transportCounters)

  return (
    <div className={styles.wrapper}>
      <h2 className={styles.heading}>Developer metrics</h2>
      <dl className={styles.grid}>
        <Metric label="SSE events/sec" value={counters.sseEventsPerSecond.toFixed(1)} testId="metric-sse-events-per-sec" />
        <Metric
          label="WS ping/pong RTT"
          value={counters.wsLastPingRttMs === null ? 'not yet measured' : `${counters.wsLastPingRttMs} ms`}
          testId="metric-ws-rtt"
        />
        <Metric label="SSE dropped" value={String(counters.sseDroppedMessages)} testId="metric-sse-dropped" />
        <Metric label="WS dropped" value={String(counters.wsDroppedMessages)} testId="metric-ws-dropped" />
        <Metric label="SSE reconnects" value={String(counters.sseReconnects)} testId="metric-sse-reconnects" />
        <Metric label="WS reconnects" value={String(counters.wsReconnects)} testId="metric-ws-reconnects" />
      </dl>
    </div>
  )
}

registerWidget({ id: 'dev-metrics', title: 'Developer metrics', component: DevMetrics })
