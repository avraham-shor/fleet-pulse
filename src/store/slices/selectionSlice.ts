// FleetPulse — truck selection slice (FR-20)
//
// The seam `FleetOverview` and `VehicleDetail` share: which truck (if any)
// the dispatcher has selected to inspect in the detail panel. Cross-widget
// shared state, so it gets its own tiny slice rather than living on
// `fleetSlice` or `App.tsx` local state (Design Notes) — widgets
// communicate only through the store, never through each other or the
// shell directly.

import type { StateCreator } from 'zustand'
import type { FleetPulseStore } from '../store.ts'

export interface SelectionState {
  selectedTruckId: string | null
}

export interface SelectionSlice {
  selection: SelectionState
  /** `FleetOverview`'s roster-row click handler is this action's only
   * production caller today; `null` clears the selection (mirrors
   * `dispatcher_viewing`'s explicit-clear convention, though this slice is
   * purely local UI state, never broadcast). */
  selectTruck: (truckId: string | null) => void
}

export const createSelectionSlice: StateCreator<FleetPulseStore, [], [], SelectionSlice> = (set) => ({
  selection: { selectedTruckId: null },
  selectTruck: (truckId) => set({ selection: { selectedTruckId: truckId } }),
})

export function selectSelectedTruckId(state: Pick<FleetPulseStore, 'selection'>): string | null {
  return state.selection.selectedTruckId
}
