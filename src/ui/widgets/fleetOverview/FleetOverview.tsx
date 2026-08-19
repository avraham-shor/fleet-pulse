// FleetPulse — live fleet overview widget (FR-1, FR-2, FR-3, FR-4, AD-14)
//
// An SVG coordinate grid: one marker per truck, snapped to the newest-by-
// timestamp position (never a per-batch flurry of markers — the pipeline
// already collapses a batch to one `latest` envelope, telemetrySlice.ts),
// plus one timestamp-sorted trail polyline over that signal's bounded
// history. Status (FR-2) comes only from the initial `GET /api/fleet`
// snapshot (Design Notes); staleness (FR-4) comes only from
// `selectEffectiveTrust(truckId, 'position')`, rendered through the one
// shared `TrustBadge` — never a widget-invented visual (AD-3).
//
// `ui/` imports only `store/` (AD-1): the fleet slice for roster/status,
// telemetry selectors for position, the effective-trust selector for
// staleness. No `pipeline/`, no transport.

import { useMemo } from 'react'
import { getFleetPulseStore } from '../../../store/store.ts'
import { selectFleetTrucks, selectFleetFetchStatus } from '../../../store/slices/fleetSlice.ts'
import { selectSignalTelemetry } from '../../../store/slices/telemetrySlice.ts'
import { selectEffectiveTrust } from '../../../store/selectors/effectiveTrust.ts'
import type { Truck } from '../../../contract/rest.ts'
import { TrustBadge } from '../../TrustBadge.tsx'
import { registerWidget } from '../../registry.ts'
import { computeBounds, createProjection, isLatLng, SVG_VIEWBOX_HEIGHT, SVG_VIEWBOX_WIDTH, type LatLng, type ProjectedPoint } from './project.ts'
import styles from './FleetOverview.module.css'

const useFleetPulseStore = getFleetPulseStore()

interface TruckMarkerGroupProps {
  truck: Truck
  position: LatLng | null
  trail: LatLng[]
  project: (point: LatLng) => ProjectedPoint
}

function TruckMarkerGroup({ truck, position, trail, project }: TruckMarkerGroupProps) {
  const trust = useFleetPulseStore(selectEffectiveTrust(truck.truckId, 'position'))

  // FR-5 cold start: no live position for this truck yet — nothing
  // trustworthy to plot, so no marker (never a guess at a coordinate).
  if (position === null) return null

  const marker = project(position)
  // FR-3: one polyline over the whole sorted trail (bounded history,
  // AD-15), including the newest point itself, so the line visibly reaches
  // the marker rather than stopping one point short. A single-point trail
  // draws no line — nothing to connect yet.
  const trailPoints = trail.length > 1 ? trail.map((point) => { const p = project(point); return `${p.x},${p.y}` }).join(' ') : ''

  return (
    <g data-truck-id={truck.truckId} data-testid={`marker-${truck.truckId}`}>
      {trailPoints && <polyline className={styles.trail} points={trailPoints} data-testid={`trail-${truck.truckId}`} />}
      <circle
        className={styles.marker}
        data-status={truck.status}
        data-trust={trust ?? 'none'}
        cx={marker.x}
        cy={marker.y}
        r={10}
      />
      <text className={styles.markerLabel} x={marker.x} y={marker.y - 14} textAnchor="middle">
        {truck.truckId}
      </text>
    </g>
  )
}

function TruckRosterRow({ truck }: { truck: Truck }) {
  const trust = useFleetPulseStore(selectEffectiveTrust(truck.truckId, 'position'))

  // FR-20: the roster row is the click affordance that opens the detail
  // panel — dispatches into the shared `selectionSlice`, never a direct
  // prop/callback into `VehicleDetail` (widgets communicate only through
  // the store, Design Notes). `useFleetPulseStore.getState()` reads the
  // action without subscribing to it — this handler doesn't need to
  // re-render when the selection changes.
  function handleSelect() {
    useFleetPulseStore.getState().selectTruck(truck.truckId)
  }

  return (
    <li
      className={styles.rosterRow}
      data-testid={`roster-row-${truck.truckId}`}
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleSelect()
        }
      }}
    >
      <span className={styles.statusDot} data-status={truck.status} aria-hidden="true" />
      <span className={styles.truckId}>{truck.truckId}</span>
      <span className={styles.statusLabel}>{truck.status}</span>
      <TrustBadge trust={trust} />
    </li>
  )
}

export function FleetOverview() {
  // Selecting the raw record (a referentially-stable field — only replaced
  // on an actual `setFleet` commit) and sorting it locally via `useMemo`,
  // rather than subscribing with `selectFleetTrucks` directly: that
  // selector builds a fresh sorted array on every call, and Zustand's
  // `useSyncExternalStore`-backed hook compares snapshots by reference —
  // a selector that never returns the same reference twice re-triggers a
  // "changed" render every time, which starves out into React's "Maximum
  // update depth exceeded" infinite-loop guard.
  const fleetTrucks = useFleetPulseStore((state) => state.fleet.trucks)
  const fetchStatus = useFleetPulseStore(selectFleetFetchStatus)
  const telemetryTrucks = useFleetPulseStore((state) => state.telemetry.trucks)
  const trucks = useMemo(() => selectFleetTrucks({ fleet: { trucks: fleetTrucks, fetchStatus } }), [fleetTrucks, fetchStatus])

  if (fetchStatus === 'error') {
    // `app/bootstrap.ts` calls `getFleet()` exactly once — by the time
    // `fetchStatus` flips to 'error' the api-client has already exhausted
    // its own retry/breaker budget (FR-24/FR-25), so nothing is actually
    // retrying anymore; the copy must not promise otherwise.
    return (
      <div className={styles.status} role="alert">
        Fleet unavailable
      </div>
    )
  }
  if (fetchStatus === 'pending') {
    return <div className={styles.status}>Loading fleet…</div>
  }

  const truckPositions = trucks.map((truck) => {
    const positionSignal = selectSignalTelemetry({ telemetry: { trucks: telemetryTrucks } }, truck.truckId, 'position')
    const latestValue = positionSignal?.latest?.value
    const position = isLatLng(latestValue) ? latestValue : null
    const trail = (positionSignal?.history.toArray() ?? []).map((reading) => reading.value).filter(isLatLng)
    return { truck, position, trail }
  })

  const bounds = computeBounds(truckPositions.flatMap((entry) => (entry.position ? [entry.position] : [])))
  const project = createProjection(bounds)

  return (
    <div className={styles.wrapper}>
      <svg
        className={styles.grid}
        viewBox={`0 0 ${SVG_VIEWBOX_WIDTH} ${SVG_VIEWBOX_HEIGHT}`}
        role="img"
        aria-label="Fleet position grid"
      >
        {truckPositions.map(({ truck, position, trail }) => (
          <TruckMarkerGroup key={truck.truckId} truck={truck} position={position} trail={trail} project={project} />
        ))}
      </svg>
      <ul className={styles.roster}>
        {trucks.map((truck) => (
          <TruckRosterRow key={truck.truckId} truck={truck} />
        ))}
      </ul>
    </div>
  )
}

registerWidget({ id: 'fleet-overview', title: 'Fleet overview', component: FleetOverview })
