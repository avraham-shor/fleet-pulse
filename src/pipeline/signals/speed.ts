// FleetPulse — speed classifier (FR-7)
//
// Two thresholds, three outcomes (trust-model.md):
//   speed > SENSOR_FAULT_CEILING_KMH        -> sensor-fault
//   OVERSPEED_ALERT_KMH < speed <= ceiling  -> trusted (real overspeed, CM1)
//   speed <= OVERSPEED_ALERT_KMH            -> trusted
//
// "Last plausible speed retained live" (I/O matrix) needs one piece of
// per-truck state: the most recent trusted value. `live` mode reads *and*
// writes it; `backfill` mode only reads it (AD-4's "stateless plausibility
// only") so a historical out-of-order reading can never seed or overwrite
// the baseline a later live reading depends on.

import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { AnomalyEntry } from '../types.ts'
import { registerSignal, type ClassifyContext, type ClassifyResult } from './registry.ts'

export interface SpeedState {
  lastPlausibleKmh: number | null
}

/** Exported for direct unit testing (speed.test.ts); the registry wraps
 * this same function for pipeline use. */
export function classifySpeed(valueKmh: number, state: SpeedState, ctx: ClassifyContext): ClassifyResult<number> {
  if (valueKmh > CLIENT_THRESHOLDS.SENSOR_FAULT_CEILING_KMH) {
    const anomalies: AnomalyEntry[] = [
      {
        ruleId: 'speed-sensor-fault',
        truckId: ctx.truckId,
        rawValue: valueKmh,
        readingTs: ctx.readingTs,
        arrivalTs: ctx.arrivalTs,
      },
    ]
    // No plausible baseline yet (e.g. the truck's very first-ever reading
    // is itself a sensor fault) — nothing trustworthy to show; FR-5's "no
    // trusted reading yet" state persists rather than showing a guess.
    if (state.lastPlausibleKmh === null) return { reading: null, anomalies }
    return {
      reading: { value: state.lastPlausibleKmh, trust: 'sensor-fault', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs },
      anomalies,
    }
  }

  // Plausible — whether a real overspeed (alert-worthy from the first
  // reading, CM1) or ordinary speed, both are `trusted`; the badge/alert
  // distinction is a UI concern reading the value itself, not a sixth
  // trust state.
  if (ctx.mode === 'live') state.lastPlausibleKmh = valueKmh
  return {
    reading: { value: valueKmh, trust: 'trusted', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs },
    anomalies: [],
  }
}

registerSignal<number, SpeedState>({
  name: 'speed',
  extractRawValue: (reading) => reading.speed,
  createInitialState: () => ({ lastPlausibleKmh: null }),
  classify: classifySpeed,
})
