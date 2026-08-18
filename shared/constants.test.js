import { describe, expect, it } from 'vitest'
import { CLIENT_THRESHOLDS, SERVER_PARAMS } from './constants.js'

describe('shared/constants', () => {
  it('exports every tunable as a finite number, except named/id fields', () => {
    const nonNumeric = new Set(['STUCK_SPEED_TRUCK_ID'])
    for (const [group, values] of Object.entries({ CLIENT_THRESHOLDS, SERVER_PARAMS })) {
      for (const [key, value] of Object.entries(values)) {
        if (nonNumeric.has(key)) continue
        expect(Number.isFinite(value), `${group}.${key} should be a finite number`).toBe(true)
      }
    }
  })

  it('pairs the overspeed alert threshold below the sensor-fault ceiling (CM1)', () => {
    expect(CLIENT_THRESHOLDS.OVERSPEED_ALERT_KMH).toBeLessThan(
      CLIENT_THRESHOLDS.SENSOR_FAULT_CEILING_KMH,
    )
  })

  it('pairs the stuck-speed sensor value above the sensor-fault ceiling it must trip', () => {
    expect(SERVER_PARAMS.STUCK_SPEED_KMH).toBeGreaterThan(CLIENT_THRESHOLDS.SENSOR_FAULT_CEILING_KMH)
  })

  it('keeps the GPS batch size range non-inverted', () => {
    expect(SERVER_PARAMS.GPS_BATCH_SIZE_MIN).toBeLessThanOrEqual(SERVER_PARAMS.GPS_BATCH_SIZE_MAX)
  })

  it('keeps reconnect backoff bounds non-inverted', () => {
    expect(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS).toBeLessThanOrEqual(
      CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS,
    )
  })
})
