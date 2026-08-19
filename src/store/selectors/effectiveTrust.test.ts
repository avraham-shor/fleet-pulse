// FleetPulse — effective-trust selector tests (AD-3)

import { describe, expect, it } from 'vitest'
import { computeEffectiveTrust, selectEffectiveTrust, tickEffectiveTrust } from './effectiveTrust.ts'
import { createFleetPulseStore } from '../store.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { Reading } from '../../pipeline/types.ts'

describe('computeEffectiveTrust', () => {
  it('FR-5: no reading at all yet -> null ("no trusted reading yet"), not one of the five badge states', () => {
    expect(computeEffectiveTrust(null, 0, false)).toBeNull()
  })

  it('a fresh reading passes its pipeline trust straight through when not degraded', () => {
    const reading: Reading<number> = { value: 60, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_000 }
    expect(computeEffectiveTrust(reading, 1_000, false)).toBe('trusted')
    const suspect: Reading<number> = { value: 60, trust: 'suspect', readingTs: 1_000, arrivalTs: 1_000 }
    expect(computeEffectiveTrust(suspect, 1_000, false)).toBe('suspect')
    const fault: Reading<number> = { value: 60, trust: 'sensor-fault', readingTs: 1_000, arrivalTs: 1_000 }
    expect(computeEffectiveTrust(fault, 1_000, false)).toBe('sensor-fault')
  })

  it('staleness is measured on the arrival clock, not the reading clock (trust-model.md two-clock rule)', () => {
    // A reading whose readingTs is 10 minutes old but arrived just now is
    // fresh contact, not stale (a GPS batch replaying old timestamps).
    const reading: Reading<number> = { value: 60, trust: 'trusted', readingTs: 0, arrivalTs: 100_000 }
    expect(computeEffectiveTrust(reading, 100_000, false)).toBe('trusted')
  })

  it('exceeding STALENESS_BADGE_THRESHOLD_MS since arrival -> stale', () => {
    const reading: Reading<number> = { value: 60, trust: 'trusted', readingTs: 0, arrivalTs: 0 }
    const now = CLIENT_THRESHOLDS.STALENESS_BADGE_THRESHOLD_MS + 1
    expect(computeEffectiveTrust(reading, now, false)).toBe('stale')
  })

  it('right at the threshold is not yet stale', () => {
    const reading: Reading<number> = { value: 60, trust: 'trusted', readingTs: 0, arrivalTs: 0 }
    expect(computeEffectiveTrust(reading, CLIENT_THRESHOLDS.STALENESS_BADGE_THRESHOLD_MS, false)).toBe('trusted')
  })

  it('AD-9: degraded overrides everything, even a fresh trusted reading', () => {
    const reading: Reading<number> = { value: 60, trust: 'trusted', readingTs: 0, arrivalTs: 0 }
    expect(computeEffectiveTrust(reading, 0, true)).toBe('degraded')
  })
})

describe('selectEffectiveTrust + tickEffectiveTrust (store wiring)', () => {
  it('reads through telemetry + health, and re-evaluates staleness once tickStaleness runs', () => {
    const store = createFleetPulseStore()
    store.getState().applyTelemetryCommits([
      {
        truckId: 'truck_1',
        signals: [
          { signal: 'speed', live: { value: 60, trust: 'trusted', readingTs: 0, arrivalTs: 0 }, historyEntries: [] },
        ],
      },
    ])
    store.getState().tickStaleness(0)
    expect(selectEffectiveTrust('truck_1', 'speed')(store.getState())).toBe('trusted')

    // Time passes with no new reading — the tick-driven recompute AD-3
    // calls for is what makes this visible without a fresh reading.
    tickEffectiveTrust(store.getState(), CLIENT_THRESHOLDS.STALENESS_BADGE_THRESHOLD_MS + 1)
    expect(selectEffectiveTrust('truck_1', 'speed')(store.getState())).toBe('stale')
  })

  it('a truck/signal with no telemetry at all reads as null', () => {
    const store = createFleetPulseStore()
    expect(selectEffectiveTrust('truck_9', 'fuel')(store.getState())).toBeNull()
  })

  it('setDegraded flips every signal to degraded via the same selector', () => {
    const store = createFleetPulseStore()
    store.getState().applyTelemetryCommits([
      { truckId: 'truck_1', signals: [{ signal: 'fuel', live: { value: 70, trust: 'trusted', readingTs: 0, arrivalTs: 0 }, historyEntries: [] }] },
    ])
    store.getState().setDegraded(true, 'telemetryStreamDown')
    expect(selectEffectiveTrust('truck_1', 'fuel')(store.getState())).toBe('degraded')
  })
})
