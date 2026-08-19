// FleetPulse — health slice: minimal scaffold only
//
// Story 4 needs `health.isDegraded` to exist so the effective-trust
// selector (AD-3) can layer it over pipeline trust; populating this slice
// from real circuit-breaker/connection signals is story 1.9's job. `setDegraded`
// exists only so this slice — and the selector reading it — are testable in
// isolation; nothing in this story calls it from a real transport signal.
//
// `nowMs` is the wall-clock snapshot the effective-trust selector compares
// each reading's `arrivalTs` against for staleness. It only changes when
// `tickStaleness` is called — the "tick-driven recompute function" AD-3
// calls for; `app/` is what will start a `STALENESS_TICK_MS` interval
// calling it, later.

import type { StateCreator } from 'zustand'
import type { FleetPulseStore } from '../store.ts'

export interface HealthState {
  isDegraded: boolean
  reason: string | null
  nowMs: number
}

export interface HealthSlice {
  health: HealthState
  setDegraded: (isDegraded: boolean, reason: string | null) => void
  tickStaleness: (nowMs?: number) => void
}

export const createHealthSlice: StateCreator<FleetPulseStore, [], [], HealthSlice> = (set) => ({
  health: { isDegraded: false, reason: null, nowMs: Date.now() },
  setDegraded: (isDegraded, reason) => set((state) => ({ health: { ...state.health, isDegraded, reason } })),
  tickStaleness: (nowMs = Date.now()) => set((state) => ({ health: { ...state.health, nowMs } })),
})
