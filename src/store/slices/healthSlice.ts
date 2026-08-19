// FleetPulse — health slice: AD-9 named-conditions degraded mode
//
// Two named conditions, each set only by its owning transport component via
// app/'s wiring — never inferred or set by a widget (AD-9):
//   - `telemetryStreamDown`: sse-manager's connection-status callback
//     (app/bootstrap.ts wires `onConnectionChange` into `setTelemetryStreamDown`)
//   - `fleetFetchFailing`: api-client's circuit breaker, polled via
//     `getBreakerState()` on the staleness tick (app/bootstrap.ts) — the
//     breaker's own state machine lives entirely in api-client.ts and is
//     never touched here (Boundaries & Constraints).
//
// Setting a condition *down* is immediate; clearing it is hysteresis-gated:
// `BANNER_CLEAR_HYSTERESIS_MS` of continuous health must elapse before the
// condition flips back to healthy, so a flapping connection never flaps the
// banner (CM2, FR-26). Each condition's hysteresis clock is evaluated on
// `tickStaleness` — the same 1s tick app/ already runs for AD-3's staleness
// re-evaluation and FR-19's presence sweep, piggybacked here rather than
// adding a second interval.
//
// `nowMs` is unchanged from the prior scaffold: the wall-clock snapshot the
// effective-trust selector compares each reading's `arrivalTs` against.
//
// This is a breaking shape change (Design Notes): the old `isDegraded`/
// `reason` fields are replaced, not kept alongside these two.

import type { StateCreator } from 'zustand'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { FleetPulseStore } from '../store.ts'

export interface HealthState {
  telemetryStreamDown: boolean
  fleetFetchFailing: boolean
  nowMs: number
  /** Hysteresis bookkeeping, private to this slice's own tick logic: the
   * wall-clock timestamp since the underlying raw signal has been
   * continuously healthy, or `null` while it's actively unhealthy or
   * already fully cleared. `tickStaleness` compares this against `nowMs` to
   * decide when the condition above may flip back to healthy. Not part of
   * AD-9's named-conditions vocabulary itself — just how this slice
   * implements the "5s of continuous health" clear rule. */
  telemetryHealthySinceMs: number | null
  fleetHealthySinceMs: number | null
}

export interface HealthSlice {
  health: HealthState
  /** sse-manager's connection-status callback (app/bootstrap.ts) calls this
   * on every open/error. `down: true` is immediate; `down: false` starts
   * (or leaves already-running) the hysteresis clock rather than clearing
   * the condition on the spot — `tickStaleness` is what actually flips it
   * once the window elapses. */
  setTelemetryStreamDown: (down: boolean, now?: number) => void
  /** Polled from `apiClient.getBreakerState()` on the staleness tick
   * (app/bootstrap.ts) — same immediate-set/hysteresis-clear rule as
   * `setTelemetryStreamDown`. */
  setFleetFetchFailing: (failing: boolean, now?: number) => void
  /** Bumps `nowMs` (AD-3's tick-driven staleness recompute) and, on the same
   * tick, flips any condition whose hysteresis clock has elapsed back to
   * healthy. */
  tickStaleness: (nowMs?: number) => void
}

interface ConditionResult {
  down: boolean
  healthySinceMs: number | null
}

/** One condition's reaction to a fresh report from its owning transport
 * component. A `down` report always wins immediately and cancels any
 * pending clear; a `healthy` report while already healthy is a no-op; a
 * `healthy` report while still down starts the hysteresis clock (or leaves
 * an already-running one alone — a repeated healthy report never pushes the
 * clear deadline back out). */
function applyConditionReport(down: boolean, now: number, currentDown: boolean, currentHealthySinceMs: number | null): ConditionResult {
  if (down) return { down: true, healthySinceMs: null }
  if (!currentDown) return { down: false, healthySinceMs: null }
  return { down: true, healthySinceMs: currentHealthySinceMs ?? now }
}

/** One condition's reaction to a tick: flips back to healthy once its
 * hysteresis clock has run for `BANNER_CLEAR_HYSTERESIS_MS` (CM2, FR-26). */
function applyConditionTick(down: boolean, healthySinceMs: number | null, nowMs: number): ConditionResult {
  if (!down || healthySinceMs === null) return { down, healthySinceMs }
  if (nowMs - healthySinceMs >= CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS) return { down: false, healthySinceMs: null }
  return { down, healthySinceMs }
}

export const createHealthSlice: StateCreator<FleetPulseStore, [], [], HealthSlice> = (set) => ({
  health: {
    telemetryStreamDown: false,
    fleetFetchFailing: false,
    nowMs: Date.now(),
    telemetryHealthySinceMs: null,
    fleetHealthySinceMs: null,
  },
  setTelemetryStreamDown: (down, now = Date.now()) =>
    set((state) => {
      const next = applyConditionReport(down, now, state.health.telemetryStreamDown, state.health.telemetryHealthySinceMs)
      return { health: { ...state.health, telemetryStreamDown: next.down, telemetryHealthySinceMs: next.healthySinceMs } }
    }),
  setFleetFetchFailing: (failing, now = Date.now()) =>
    set((state) => {
      const next = applyConditionReport(failing, now, state.health.fleetFetchFailing, state.health.fleetHealthySinceMs)
      return { health: { ...state.health, fleetFetchFailing: next.down, fleetHealthySinceMs: next.healthySinceMs } }
    }),
  tickStaleness: (nowMs = Date.now()) =>
    set((state) => {
      const telemetry = applyConditionTick(state.health.telemetryStreamDown, state.health.telemetryHealthySinceMs, nowMs)
      const fleet = applyConditionTick(state.health.fleetFetchFailing, state.health.fleetHealthySinceMs, nowMs)
      return {
        health: {
          ...state.health,
          nowMs,
          telemetryStreamDown: telemetry.down,
          telemetryHealthySinceMs: telemetry.healthySinceMs,
          fleetFetchFailing: fleet.down,
          fleetHealthySinceMs: fleet.healthySinceMs,
        },
      }
    }),
})

/** True whenever either named condition is currently down (AD-9) — the one
 * combined read `effectiveTrust.ts` and `DegradedBanner.tsx` both share,
 * rather than each re-deriving the OR themselves. */
export function selectIsDegraded(state: Pick<FleetPulseStore, 'health'>): boolean {
  return state.health.telemetryStreamDown || state.health.fleetFetchFailing
}
