// FleetPulse — the one effective-trust selector (AD-3)
//
// Layers staleness (arrival clock vs. STALENESS_BADGE_THRESHOLD_MS) and
// `health.isDegraded` on top of the pipeline's per-signal plausibility
// trust, producing trust-model.md's five-state result. This is the only
// trust source a future widget reads — nothing above the store re-derives
// staleness or degraded state itself (AD-3, AD-9).
//
// Degraded takes priority over staleness: a system-level data source being
// down is a stronger, more systemic statement than "no fresh contact from
// this one truck yet" — "old data is never presented as fresh" (FR-26)
// reads most naturally as the more severe condition winning when both are
// true simultaneously.

import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { Reading, SignalName } from '../../pipeline/types.ts'
import { selectSignalTelemetry } from '../slices/telemetrySlice.ts'
import type { FleetPulseStore } from '../store.ts'

/** The five PRD trust-model.md states. `null` is not a sixth state — it
 * means no reading exists at all yet (FR-5's "no trusted reading yet"
 * cold-start case), which is a distinct, textual UI treatment rather than
 * a badge over a value that doesn't exist. */
export type EffectiveTrust = 'trusted' | 'suspect' | 'sensor-fault' | 'stale' | 'degraded'

export function computeEffectiveTrust(
  reading: Reading<unknown> | null,
  nowMs: number,
  isDegraded: boolean,
): EffectiveTrust | null {
  if (reading === null) return null
  if (isDegraded) return 'degraded'
  if (nowMs - reading.arrivalTs > CLIENT_THRESHOLDS.STALENESS_BADGE_THRESHOLD_MS) return 'stale'
  return reading.trust
}

/** A selector factory: `useFleetPulseStore(selectEffectiveTrust(truckId, 'speed'))`. */
export function selectEffectiveTrust(truckId: string, signal: SignalName) {
  return (state: Pick<FleetPulseStore, 'telemetry' | 'health'>): EffectiveTrust | null => {
    const signalTelemetry = selectSignalTelemetry(state, truckId, signal)
    return computeEffectiveTrust(signalTelemetry?.latest ?? null, state.health.nowMs, state.health.isDegraded)
  }
}

/**
 * The tick-driven recompute function AD-3 calls for: re-evaluates every
 * `selectEffectiveTrust` subscriber against the current wall clock by
 * bumping `health.nowMs`. `app/` is what starts a `STALENESS_TICK_MS`
 * interval calling this, later — this story only exports the function.
 */
export function tickEffectiveTrust(store: Pick<FleetPulseStore, 'tickStaleness'>, nowMs: number = Date.now()): void {
  store.tickStaleness(nowMs)
}
