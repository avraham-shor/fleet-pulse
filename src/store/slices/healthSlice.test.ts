// FleetPulse — health slice tests (AD-9, FR-26, CM2)

import { describe, expect, it } from 'vitest'
import { createFleetPulseStore } from '../store.ts'
import { selectIsDegraded } from './healthSlice.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'

describe('healthSlice', () => {
  it('starts healthy: both conditions false', () => {
    const store = createFleetPulseStore()
    expect(store.getState().health.telemetryStreamDown).toBe(false)
    expect(store.getState().health.fleetFetchFailing).toBe(false)
    expect(selectIsDegraded(store.getState())).toBe(false)
  })

  it('setTelemetryStreamDown(true) is immediate', () => {
    const store = createFleetPulseStore()
    store.getState().setTelemetryStreamDown(true, 0)
    expect(store.getState().health.telemetryStreamDown).toBe(true)
    expect(selectIsDegraded(store.getState())).toBe(true)
  })

  it('setFleetFetchFailing(true) is immediate and independent of the telemetry condition', () => {
    const store = createFleetPulseStore()
    store.getState().setFleetFetchFailing(true, 0)
    expect(store.getState().health.fleetFetchFailing).toBe(true)
    expect(store.getState().health.telemetryStreamDown).toBe(false)
  })

  it('FR-26/CM2: reporting healthy does not clear the condition on the spot — it stays down until BANNER_CLEAR_HYSTERESIS_MS of continuous health elapses via tickStaleness', () => {
    const store = createFleetPulseStore()
    store.getState().setTelemetryStreamDown(true, 0)
    store.getState().setTelemetryStreamDown(false, 1_000) // recovered, but hysteresis hasn't elapsed
    expect(store.getState().health.telemetryStreamDown).toBe(true)

    store.getState().tickStaleness(1_000 + CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS - 1)
    expect(store.getState().health.telemetryStreamDown).toBe(true) // not yet

    store.getState().tickStaleness(1_000 + CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS)
    expect(store.getState().health.telemetryStreamDown).toBe(false)
  })

  it('a repeated healthy report never pushes the clear deadline back out', () => {
    const store = createFleetPulseStore()
    store.getState().setTelemetryStreamDown(true, 0)
    store.getState().setTelemetryStreamDown(false, 1_000) // healthySinceMs = 1000
    store.getState().setTelemetryStreamDown(false, 4_000) // repeated healthy report — must not reset the clock to 4000

    // If the clock had reset to 4000, this tick (1000 + hysteresis) would
    // still show down=true; it must already be clear since the clock is
    // still anchored at 1000.
    store.getState().tickStaleness(1_000 + CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS)
    expect(store.getState().health.telemetryStreamDown).toBe(false)
  })

  it('a fresh down report cancels a pending clear and restarts the hysteresis clock', () => {
    const store = createFleetPulseStore()
    store.getState().setTelemetryStreamDown(true, 0)
    store.getState().setTelemetryStreamDown(false, 1_000) // pending clear from 1000
    store.getState().setTelemetryStreamDown(true, 2_000) // flaps back down before it clears

    store.getState().tickStaleness(1_000 + CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS)
    expect(store.getState().health.telemetryStreamDown).toBe(true) // still down — the clock restarted at 2000

    store.getState().setTelemetryStreamDown(false, 2_000)
    store.getState().tickStaleness(2_000 + CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS)
    expect(store.getState().health.telemetryStreamDown).toBe(false)
  })

  it('the two conditions clear independently — CM2 "no flap" per condition', () => {
    const store = createFleetPulseStore()
    store.getState().setTelemetryStreamDown(true, 0)
    store.getState().setFleetFetchFailing(true, 0)
    store.getState().setTelemetryStreamDown(false, 1_000)
    // fleetFetchFailing still actively down (no healthy report yet)

    store.getState().tickStaleness(1_000 + CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS)
    expect(store.getState().health.telemetryStreamDown).toBe(false)
    expect(store.getState().health.fleetFetchFailing).toBe(true)
    expect(selectIsDegraded(store.getState())).toBe(true) // banner stays up — one condition still down

    store.getState().setFleetFetchFailing(false, 1_000 + CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS)
    store.getState().tickStaleness(1_000 + 2 * CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS)
    expect(selectIsDegraded(store.getState())).toBe(false)
  })

  it('tickStaleness always advances nowMs regardless of condition state (AD-3 wiring untouched)', () => {
    const store = createFleetPulseStore()
    store.getState().tickStaleness(42)
    expect(store.getState().health.nowMs).toBe(42)
  })

  it('setTelemetryStreamDown(false) while already healthy is a no-op — no dangling healthySinceMs', () => {
    const store = createFleetPulseStore()
    store.getState().setTelemetryStreamDown(false, 500)
    expect(store.getState().health.telemetryStreamDown).toBe(false)
    expect(store.getState().health.telemetryHealthySinceMs).toBeNull()
  })
})
