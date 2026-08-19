// FleetPulse — fleet slice: the 12-truck roster snapshot (FR-1, FR-2) +
// per-truck broadcast alerts (FR-22, FR-32, CM1)
//
// Status changes are driven by route mutations (story 1.7) and presence
// isn't wired until 1.6, so within this story's scope the roster is
// populated once from `GET /api/fleet` at startup and never live-updated
// after that (Design Notes) — this slice holds exactly that snapshot plus
// the fetch lifecycle status the fleet-overview widget renders around
// (pending/ready/error — the I/O matrix's loading and "fleet unavailable"
// states).
//
// Story 9 adds `alerts`: a per-truck bounded buffer (AD-10) of every
// `truck_alert` this session has seen for that truck, fed by
// `app/bootstrap.ts`'s WS `truck_alert` handler (never a widget writing
// directly). Per the architecture spine's state-mutation table, an alert
// for a `truckId` outside the current roster upserts a stub `Truck` rather
// than being dropped (CM1: uncertainty about an unrecognized id must never
// suppress a broadcast alert).

import type { StateCreator } from 'zustand'
import type { Truck, TruckAlert } from '../../contract/rest.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import { createBoundedBuffer, type BoundedBuffer } from '../boundedBuffer.ts'
import type { FleetPulseStore } from '../store.ts'

export type FleetFetchStatus = 'pending' | 'ready' | 'error'

export interface FleetState {
  trucks: Record<string, Truck>
  fetchStatus: FleetFetchStatus
  /** Keyed by `truckId` — every alert this session has seen for that truck,
   * bounded (AD-10). A truck with no alerts yet simply has no entry here
   * (never an eagerly-created empty buffer for all 12 trucks). */
  alerts: Record<string, BoundedBuffer<TruckAlert>>
}

export interface FleetSlice {
  fleet: FleetState
  /** Applies the initial (and, this story, only) `GET /api/fleet` roster —
   * keyed by `truckId` for O(1) per-truck lookup. */
  setFleet: (trucks: Truck[]) => void
  /** The initial fetch exhausted its retry/breaker budget (I/O matrix:
   * "fleet unavailable"); the widget renders an inline error state, never
   * a modal (CM2). */
  setFleetFetchFailed: () => void
  /** `truck_alert` WS echo handler (FR-32) — appends to that truck's bounded
   * alert buffer. An alert for a `truckId` not already in `trucks` upserts a
   * minimal stub `Truck` first (CM1) rather than being dropped for
   * referencing an unrecognized id. */
  addTruckAlert: (alert: TruckAlert) => void
  /** `fleet_reset` step (AD-8, FR-33): wipes every per-truck alert buffer
   * back to empty. Alerts are session-scoped derived state, the same
   * category trust-model.md documents for the anomaly log ("wiped by a
   * fleet reset along with the rest of derived state") — this story's own
   * addition needs the same treatment. The roster itself (including any
   * CM1 stub truck an alert upserted) is untouched here; only the alert
   * history clears. */
  resetFleetAlerts: () => void
}

/** A stub roster entry for an alert that named a `truckId` this client's
 * roster doesn't (yet) know about — every numeric field is a neutral
 * placeholder; the live telemetry selectors (AD-3), not this snapshot, are
 * what actually drive the detail panel's readings, so a stub's zeros are
 * never rendered as a trusted value. */
function createStubTruck(truckId: string, timestamp: number): Truck {
  return {
    truckId,
    status: 'idle',
    lat: 0,
    lng: 0,
    speed: 0,
    fuel: 0,
    engineTemp: 0,
    mileage: 0,
    timestamp,
    routeId: null,
  }
}

function createAlertsBuffer(): BoundedBuffer<TruckAlert> {
  return createBoundedBuffer<TruckAlert>({ cap: CLIENT_THRESHOLDS.TRUCK_ALERT_CAP, orderingKey: (alert) => alert.timestamp })
}

/** Always returns a *fresh* `BoundedBuffer` instance, never the mutated-in-
 * place `existing` one handed back by reference (code-review finding: a
 * second-or-later alert to a truck that already has a buffer previously
 * reused the same object identity, so a component subscribed to
 * `state.fleet.alerts[truckId]` — e.g. `VehicleDetail`'s `AlertHistory` —
 * never saw a change under Zustand's `Object.is` equality after its first
 * mount). Unlike `telemetrySlice.ts`'s per-signal `{ latest, history }`
 * record, `alerts[truckId]` *is* the buffer itself with no wrapper level
 * above it for a fresh object to live in instead — so the buffer instance
 * itself has to be what changes reference here. Cheap: alerts are rare,
 * human-triggered events, not a per-tick telemetry flood, so rebuilding a
 * capped buffer from its own `.toArray()` on every push is in no way a hot
 * path. */
function pushToFreshAlertsBuffer(existing: BoundedBuffer<TruckAlert> | undefined, alert: TruckAlert): BoundedBuffer<TruckAlert> {
  const buffer = createAlertsBuffer()
  if (existing) {
    for (const item of existing.toArray()) buffer.push(item)
  }
  buffer.push(alert)
  return buffer
}

export const createFleetSlice: StateCreator<FleetPulseStore, [], [], FleetSlice> = (set) => ({
  fleet: { trucks: {}, fetchStatus: 'pending', alerts: {} },
  setFleet: (trucks) =>
    set((state) => ({
      fleet: {
        trucks: Object.fromEntries(trucks.map((truck) => [truck.truckId, truck])),
        fetchStatus: 'ready',
        alerts: state.fleet.alerts,
      },
    })),
  setFleetFetchFailed: () => set((state) => ({ fleet: { ...state.fleet, fetchStatus: 'error' } })),
  addTruckAlert: (alert) =>
    set((state) => {
      const trucks = state.fleet.trucks[alert.truckId]
        ? state.fleet.trucks
        : { ...state.fleet.trucks, [alert.truckId]: createStubTruck(alert.truckId, alert.timestamp) }
      const buffer = pushToFreshAlertsBuffer(state.fleet.alerts[alert.truckId], alert)
      return { fleet: { ...state.fleet, trucks, alerts: { ...state.fleet.alerts, [alert.truckId]: buffer } } }
    }),
  resetFleetAlerts: () => set((state) => ({ fleet: { ...state.fleet, alerts: {} } })),
})

/** The subset of `FleetState` these two selectors actually read — narrower
 * than `Pick<FleetPulseStore, 'fleet'>` on purpose: `FleetOverview.tsx`,
 * `RoutesPanel.tsx`, and `PresencePanel.tsx` all build a small inline
 * `{ fleet: { trucks, fetchStatus } }` literal for these two calls rather
 * than threading the whole store through (their own established
 * convention, predating `alerts`), and TS's excess/missing-property
 * checking on an object literal argument would break every one of those
 * call sites the moment `FleetState` gained a third required field this
 * pair never touches. Both `Pick<FleetPulseStore, 'fleet'>` values (the
 * real store) and this narrower literal satisfy this type equally. */
type FleetRosterSnapshot = Pick<FleetState, 'trucks' | 'fetchStatus'>

/** Read-only lookup, `truckId`-ascending in numeric-aware order (so
 * `truck_10` sorts after `truck_9`, not before `truck_2`) — the stable
 * render order every widget over the fleet roster uses. */
export function selectFleetTrucks(state: { fleet: FleetRosterSnapshot }): Truck[] {
  return Object.values(state.fleet.trucks).sort((a, b) =>
    a.truckId.localeCompare(b.truckId, undefined, { numeric: true }),
  )
}

export function selectFleetFetchStatus(state: { fleet: FleetRosterSnapshot }): FleetFetchStatus {
  return state.fleet.fetchStatus
}

/** Every alert recorded for one truck this session, oldest-first (the
 * bounded buffer's own storage order — AD-10). `VehicleDetail` reverses this
 * for newest-first display. */
export function selectTruckAlerts(state: Pick<FleetPulseStore, 'fleet'>, truckId: string): TruckAlert[] {
  return [...(state.fleet.alerts[truckId]?.toArray() ?? [])]
}
