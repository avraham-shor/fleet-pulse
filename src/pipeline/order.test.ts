// FleetPulse — order/dedupe stage tests (AD-4, FR-6)
//
// Runs in the node environment (this module imports no React/DOM) — pure
// function tests, no fake timers needed since `orderReadings` takes no
// clock dependency of its own.

import { describe, expect, it } from 'vitest'
import { createTruckCursor, orderReadings } from './order.ts'
import type { TelemetryReading } from '../contract/telemetry.ts'

function reading(timestamp: number, overrides: Partial<TelemetryReading> = {}): TelemetryReading {
  return { truckId: 'truck_1', timestamp, lat: 0, lng: 0, speed: 40, fuel: 80, engineTemp: 70, mileage: 100, ...overrides }
}

describe('orderReadings', () => {
  it('FR-6: a reading older than the cursor is tagged backfill, never advances the cursor', () => {
    const cursor = createTruckCursor()
    cursor.cursorReadingTs = 5_000
    const ordered = orderReadings([reading(1_000)], cursor)
    expect(ordered).toEqual([{ reading: reading(1_000), mode: 'backfill' }])
    expect(cursor.cursorReadingTs).toBe(5_000)
  })

  it('a reading at or after the cursor is tagged live and advances the cursor', () => {
    const cursor = createTruckCursor()
    cursor.cursorReadingTs = 5_000
    const ordered = orderReadings([reading(5_000), reading(7_000)], cursor)
    expect(ordered.map((o) => o.mode)).toEqual(['live', 'live'])
    expect(cursor.cursorReadingTs).toBe(7_000)
  })

  it('cold start (null cursor): the first reading is always live', () => {
    const cursor = createTruckCursor()
    const ordered = orderReadings([reading(1_000)], cursor)
    expect(ordered).toEqual([{ reading: reading(1_000), mode: 'live' }])
    expect(cursor.cursorReadingTs).toBe(1_000)
  })

  it('FR-6/NFR-2: a non-monotonic batch is sorted ascending by timestamp before tagging', () => {
    const cursor = createTruckCursor()
    // Newest-last on the wire, with one adjacent interior swap — mirrors
    // server.js's buildBatchEmission (Code Map).
    const readings = [reading(1_000), reading(3_000), reading(2_000), reading(4_000)]
    const ordered = orderReadings(readings, cursor)
    expect(ordered.map((o) => o.reading.timestamp)).toEqual([1_000, 2_000, 3_000, 4_000])
    expect(ordered.every((o) => o.mode === 'live')).toBe(true)
    expect(cursor.cursorReadingTs).toBe(4_000)
  })

  it('a batch straddling the cursor: earlier entries backfill, later entries go live', () => {
    const cursor = createTruckCursor()
    cursor.cursorReadingTs = 2_500
    const readings = [reading(1_000), reading(2_000), reading(3_000), reading(4_000)]
    const ordered = orderReadings(readings, cursor)
    expect(ordered.map((o) => o.mode)).toEqual(['backfill', 'backfill', 'live', 'live'])
    expect(cursor.cursorReadingTs).toBe(4_000)
  })
})
