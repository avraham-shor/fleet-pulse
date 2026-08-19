// FleetPulse — speed classifier tests (FR-7)

import { describe, expect, it } from 'vitest'
import { classifySpeed, type SpeedState } from './speed.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { ClassifyContext } from './registry.ts'

function ctx(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return { truckId: 'truck_7', readingTs: 1_000, arrivalTs: 1_010, mode: 'live', ...overrides }
}

describe('classifySpeed', () => {
  it('FR-7a: speed above the sensor-fault ceiling -> sensor-fault, last plausible speed retained, raw logged', () => {
    const state: SpeedState = { lastPlausibleKmh: 60 }
    const result = classifySpeed(999, state, ctx())
    expect(result.reading).toEqual({ value: 60, trust: 'sensor-fault', readingTs: 1_000, arrivalTs: 1_010 })
    expect(result.anomalies).toEqual([
      { ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 999, readingTs: 1_000, arrivalTs: 1_010 },
    ])
    // The raw 999 never leaks into the envelope shown as "current truth".
    expect(result.reading?.value).not.toBe(999)
  })

  it('sensor-fault with no prior plausible baseline yet: no envelope (FR-5 "no trusted reading yet"), still logged', () => {
    const state: SpeedState = { lastPlausibleKmh: null }
    const result = classifySpeed(999, state, ctx())
    expect(result.reading).toBeNull()
    expect(result.anomalies).toHaveLength(1)
  })

  it('recovery clears the fault: a plausible reading after a fault becomes trusted and updates the baseline', () => {
    const state: SpeedState = { lastPlausibleKmh: 60 }
    classifySpeed(999, state, ctx()) // fault
    const recovered = classifySpeed(65, state, ctx({ readingTs: 2_000, arrivalTs: 2_010 }))
    expect(recovered.reading).toEqual({ value: 65, trust: 'trusted', readingTs: 2_000, arrivalTs: 2_010 })
    expect(recovered.anomalies).toEqual([])
    expect(state.lastPlausibleKmh).toBe(65)
  })

  it('FR-7b: real overspeed (between the alert limit and the ceiling) is trusted from the first reading (CM1)', () => {
    const value = CLIENT_THRESHOLDS.OVERSPEED_ALERT_KMH + 5
    expect(value).toBeLessThanOrEqual(CLIENT_THRESHOLDS.SENSOR_FAULT_CEILING_KMH)
    const state: SpeedState = { lastPlausibleKmh: null }
    const result = classifySpeed(value, state, ctx())
    expect(result.reading).toEqual({ value, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_010 })
    expect(result.anomalies).toEqual([]) // never suppressed, but also never logged as a sensor anomaly — it's real
    expect(state.lastPlausibleKmh).toBe(value)
  })

  it('ordinary speed at or below the overspeed limit is trusted', () => {
    const state: SpeedState = { lastPlausibleKmh: null }
    const result = classifySpeed(80, state, ctx())
    expect(result.reading?.trust).toBe('trusted')
    expect(result.reading?.value).toBe(80)
  })

  it('backfill mode reads the baseline but never mutates it', () => {
    const state: SpeedState = { lastPlausibleKmh: 60 }
    const result = classifySpeed(80, state, ctx({ mode: 'backfill' }))
    expect(result.reading?.value).toBe(80)
    expect(state.lastPlausibleKmh).toBe(60) // untouched — stateless
  })
})
