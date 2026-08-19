// FleetPulse — vehicle detail panel (FR-20, FR-21, FR-22, FR-23, FR-32,
// AD-3, AD-15, AD-7, AD-8)
//
// The truck a dispatcher has selected (`selectionSlice`, set by
// `FleetOverview`'s roster-row click) opens here: per-signal live value +
// `TrustBadge` + bounded-history sparkline, the truck's active route, and
// an alert-send form. Registered like every other panel (`registerWidget`)
// so it gets the standard `ErrorBoundary` for free (FR-28) and renders a
// placeholder when no truck is selected.
//
// Speed/fuel/temperature/mileage are read *exclusively* through
// `selectSignalTelemetry`/`selectEffectiveTrust` (telemetry slice + AD-3
// selector) — never `Truck.speed`/`.fuel`/`.engineTemp`/`.mileage` off the
// fleet-slice roster snapshot, which is fetched once and never live-updated
// (Boundaries & Constraints). Sparklines render `.history.toArray()` from
// the same per-signal bounded buffer `FleetOverview` already reads for
// position (AD-15: store renders it, pipeline feeds it) — no call to
// `GET /api/telemetry/history/:truckId` from this widget.
//
// Alert send reuses `api-client.ts`'s already-built `sendTruckAlert` (AD-7's
// one mutation gate) through the same module-scope-client-reading-
// `getWsSendFacade()` pattern `RoutesPanel.tsx` already established — never
// a second `fetch` path. Pessimistic UI: a successful send only clears this
// form's own local state; the alert itself appears (for every dispatcher,
// sender included — FR-32) once the `truck_alert` WS echo lands in
// `fleetSlice` via `app/bootstrap.ts`.
//
// Server-originated text (route destination/actor names, alert messages)
// renders as plain JSX text nodes only (NFR-8) — no
// `dangerouslySetInnerHTML` anywhere in this file.

import { useMemo, useState, type FormEvent } from 'react'
import { getFleetPulseStore } from '../../../store/store.ts'
import { selectSelectedTruckId } from '../../../store/slices/selectionSlice.ts'
import { selectSignalTelemetry } from '../../../store/slices/telemetrySlice.ts'
import { selectEffectiveTrust } from '../../../store/selectors/effectiveTrust.ts'
import { selectRouteForTruck } from '../../../store/slices/routesSlice.ts'
import { createApiClient, type TransportFailure } from '../../../transport/api-client.ts'
import { getWsSendFacade } from '../../../transport/ws-manager.ts'
import { TrustBadge } from '../../TrustBadge.tsx'
import { registerWidget } from '../../registry.ts'
import { buildSparklinePoints, SPARKLINE_VIEWBOX_WIDTH, SPARKLINE_VIEWBOX_HEIGHT, type SparklinePoint } from './sparkline.ts'
import styles from './VehicleDetail.module.css'

const useFleetPulseStore = getFleetPulseStore()

/** The one module-scope client this widget mutates through (AD-7) — reads
 * the session-scoped dispatcher id live on every call via the WS send
 * facade's optional `getDispatcherId` (AD-17), mirroring
 * `RoutesPanel.tsx`'s identical `routesApiClient` pattern exactly. */
const vehicleDetailApiClient = createApiClient({
  getDispatcherId: () => getWsSendFacade()?.getDispatcherId?.() ?? null,
})

/** Deliberately a local literal union, not an import of `pipeline/`'s own
 * `SignalName` — `ui/` never imports `pipeline/` (AD-1). The literals below
 * are still structurally assignable everywhere a `SignalName` is expected
 * (`selectSignalTelemetry`/`selectEffectiveTrust`'s own parameter type). */
type DetailSignalName = 'speed' | 'fuel' | 'temperature' | 'mileage'

interface SignalSpec {
  signal: DetailSignalName
  label: string
  unit: string
}

/** FR-20's four signals, in display order — position is `FleetOverview`'s
 * concern, not this panel's (Boundaries & Constraints). */
const SIGNALS: SignalSpec[] = [
  { signal: 'speed', label: 'Speed', unit: 'km/h' },
  { signal: 'fuel', label: 'Fuel', unit: '%' },
  { signal: 'temperature', label: 'Engine temp', unit: '°C' },
  { signal: 'mileage', label: 'Mileage', unit: 'km' },
]

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function describeFailure(failure: TransportFailure): string {
  switch (failure.kind) {
    case 'conflict':
      return 'Unexpected conflict — try again.'
    case 'retryable':
      return `Server busy — retry in ${failure.retryAfterSeconds}s.`
    case 'error':
      return failure.body.message
  }
}

function SignalCard({ truckId, spec }: { truckId: string; spec: SignalSpec }) {
  const trust = useFleetPulseStore(selectEffectiveTrust(truckId, spec.signal))
  // Field-access selector (referentially stable until an actual telemetry
  // commit) — same convention `FleetOverview.tsx`/`PresencePanel.tsx` use to
  // avoid Zustand's "changed every render" infinite-loop pitfall.
  const telemetryTrucks = useFleetPulseStore((state) => state.telemetry.trucks)
  const signalTelemetry = selectSignalTelemetry({ telemetry: { trucks: telemetryTrucks } }, truckId, spec.signal)
  const latestValue = signalTelemetry?.latest?.value

  const historyPoints = useMemo<SparklinePoint[]>(() => {
    const history = signalTelemetry?.history.toArray() ?? []
    const points: SparklinePoint[] = []
    for (const reading of history) {
      if (isFiniteNumber(reading.value)) points.push({ readingTs: reading.readingTs, value: reading.value })
    }
    return points
  }, [signalTelemetry])
  const pathPoints = buildSparklinePoints(historyPoints)

  return (
    <div className={styles.signalCard} data-testid={`signal-${spec.signal}`}>
      <div className={styles.signalHeader}>
        <span className={styles.signalLabel}>{spec.label}</span>
        <TrustBadge trust={trust} />
      </div>
      {isFiniteNumber(latestValue) && (
        <p className={styles.signalValue}>
          {latestValue} <span className={styles.unit}>{spec.unit}</span>
        </p>
      )}
      {pathPoints !== '' && (
        <svg
          className={styles.sparkline}
          viewBox={`0 0 ${SPARKLINE_VIEWBOX_WIDTH} ${SPARKLINE_VIEWBOX_HEIGHT}`}
          role="img"
          aria-label={`${spec.label} history`}
        >
          <polyline className={styles.sparklinePath} points={pathPoints} data-testid={`sparkline-${spec.signal}`} />
        </svg>
      )}
    </div>
  )
}

function RouteDetails({ truckId }: { truckId: string }) {
  // Same field-access-then-derive convention as above — `routesState` is
  // referentially stable until an actual route echo commits.
  const routesState = useFleetPulseStore((state) => state.routes)
  const route = useMemo(() => selectRouteForTruck({ routes: routesState }, truckId), [routesState, truckId])

  if (route === null) {
    return <p className={styles.empty}>No active route</p>
  }

  return (
    <div className={styles.routeDetails} data-testid="route-details">
      <p>
        Destination: <strong>{route.destination}</strong>
      </p>
      <p>
        Status: <span data-status={route.status}>{route.status}</span>
      </p>
      <p className={styles.meta}>assigned by {route.createdBy.name}</p>
    </div>
  )
}

function AlertForm({ truckId }: { truckId: string }) {
  const [message, setMessage] = useState('')
  const [inFlight, setInFlight] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = message.trim()
    if (trimmed === '') {
      // NFR-7: rejected before submission, no request sent.
      setError('Enter a message before sending.')
      return
    }
    setError(null)
    setInFlight(true)
    const result = await vehicleDetailApiClient.sendTruckAlert(truckId, { message: trimmed })
    setInFlight(false)
    if (!result.ok) {
      setError(describeFailure(result.failure))
      return
    }
    // Pessimistic UI (AD-7): success only clears this form's own local
    // state — the alert itself appears once the truck_alert echo lands in
    // fleetSlice (FR-32, every dispatcher including the sender).
    setMessage('')
  }

  return (
    <form className={styles.alertForm} onSubmit={(event) => void handleSubmit(event)}>
      <label className={styles.label} htmlFor="vehicle-detail-alert-message">
        Send alert
      </label>
      <textarea
        id="vehicle-detail-alert-message"
        className={styles.textarea}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Message to the truck"
      />
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button className={styles.button} type="submit" disabled={inFlight}>
        {inFlight ? 'Sending…' : 'Send alert'}
      </button>
    </form>
  )
}

function AlertHistory({ truckId }: { truckId: string }) {
  // Same field-access convention: subscribes to the raw per-truck buffer
  // (stable until that truck's own alerts change), not a fresh-array-
  // returning selector.
  const alertsBuffer = useFleetPulseStore((state) => state.fleet.alerts[truckId])
  const alerts = useMemo(() => [...(alertsBuffer?.toArray() ?? [])].reverse(), [alertsBuffer])

  if (alerts.length === 0) {
    return <p className={styles.empty}>No alerts sent this session</p>
  }

  return (
    <ul className={styles.alertList} data-testid="alert-history">
      {alerts.map((alert, index) => (
        <li key={`${alert.timestamp}-${index}`} className={styles.alertRow}>
          <span className={styles.alertFrom}>{alert.dispatcherName}</span>
          <span>{alert.message}</span>
        </li>
      ))}
    </ul>
  )
}

export function VehicleDetail() {
  const selectedTruckId = useFleetPulseStore(selectSelectedTruckId)
  const fleetTrucks = useFleetPulseStore((state) => state.fleet.trucks)

  if (selectedTruckId === null) {
    return (
      <div className={styles.wrapper}>
        <p className={styles.placeholder}>Select a truck from the fleet overview to see its live detail.</p>
      </div>
    )
  }

  // The roster snapshot is read only for the truck's id/status heading —
  // never for its speed/fuel/temperature/mileage (Boundaries & Constraints).
  // A truck that exists only via a stub upsert (CM1) still renders — the
  // stub's own status ('idle') is a legitimate roster entry, not an error.
  const truck = fleetTrucks[selectedTruckId]

  return (
    <div className={styles.wrapper}>
      <h2 className={styles.heading}>
        {selectedTruckId}
        {truck ? ` — ${truck.status}` : ''}
      </h2>

      <div className={styles.signalGrid}>
        {SIGNALS.map((spec) => (
          <SignalCard key={spec.signal} truckId={selectedTruckId} spec={spec} />
        ))}
      </div>

      <div>
        <h3 className={styles.subheading}>Route</h3>
        <RouteDetails truckId={selectedTruckId} />
      </div>

      <div>
        <h3 className={styles.subheading}>Alerts</h3>
        {/* `key` forces a remount on every truck switch (code-review
         * finding) — without it, `AlertForm`'s local draft-message/error/
         * in-flight state would leak from the previously selected truck
         * into the newly selected one, since React would otherwise reuse
         * the same component instance across the prop change. */}
        <AlertForm key={selectedTruckId} truckId={selectedTruckId} />
        <AlertHistory truckId={selectedTruckId} />
      </div>
    </div>
  )
}

registerWidget({ id: 'vehicle-detail', title: 'Vehicle detail', component: VehicleDetail })
