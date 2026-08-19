// FleetPulse — fleet slice: the 12-truck roster snapshot (FR-1, FR-2)
//
// Status changes are driven by route mutations (story 1.7) and presence
// isn't wired until 1.6, so within this story's scope the roster is
// populated once from `GET /api/fleet` at startup and never live-updated
// after that (Design Notes) — this slice holds exactly that snapshot plus
// the fetch lifecycle status the fleet-overview widget renders around
// (pending/ready/error — the I/O matrix's loading and "fleet unavailable"
// states).

import type { StateCreator } from 'zustand'
import type { Truck } from '../../contract/rest.ts'
import type { FleetPulseStore } from '../store.ts'

export type FleetFetchStatus = 'pending' | 'ready' | 'error'

export interface FleetState {
  trucks: Record<string, Truck>
  fetchStatus: FleetFetchStatus
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
}

export const createFleetSlice: StateCreator<FleetPulseStore, [], [], FleetSlice> = (set) => ({
  fleet: { trucks: {}, fetchStatus: 'pending' },
  setFleet: (trucks) =>
    set({
      fleet: {
        trucks: Object.fromEntries(trucks.map((truck) => [truck.truckId, truck])),
        fetchStatus: 'ready',
      },
    }),
  setFleetFetchFailed: () => set((state) => ({ fleet: { ...state.fleet, fetchStatus: 'error' } })),
})

/** Read-only lookup, `truckId`-ascending in numeric-aware order (so
 * `truck_10` sorts after `truck_9`, not before `truck_2`) — the stable
 * render order every widget over the fleet roster uses. */
export function selectFleetTrucks(state: Pick<FleetPulseStore, 'fleet'>): Truck[] {
  return Object.values(state.fleet.trucks).sort((a, b) =>
    a.truckId.localeCompare(b.truckId, undefined, { numeric: true }),
  )
}

export function selectFleetFetchStatus(state: Pick<FleetPulseStore, 'fleet'>): FleetFetchStatus {
  return state.fleet.fetchStatus
}
