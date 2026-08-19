// FleetPulse — fuel classifier tests (FR-8, hybrid policy)

import { describe, expect, it } from 'vitest'
import { classifyFuel, type FuelState } from './fuel.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { ClassifyContext } from './registry.ts'

function ctx(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return { truckId: 'truck_1', readingTs: 1_000, arrivalTs: 1_010, mode: 'live', ...overrides }
}

function freshState(): FuelState {
  return { lastTrustedPct: null, window: null }
}

describe('classifyFuel — live mode', () => {
  it('FR-8a: prior trusted level already low -> 0% is plausible, trusted, alerts immediately, no window', () => {
    const state: FuelState = { lastTrustedPct: CLIENT_THRESHOLDS.FUEL_ALREADY_LOW_PCT - 2, window: null }
    const result = classifyFuel(0, state, ctx())
    expect(result.reading).toEqual({ value: 0, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_010 })
    expect(result.anomalies).toEqual([])
    expect(state.window).toBeNull()
  })

  it('FR-8b: cliff-drop from a healthy level -> suspect, last trusted value shown, window opens', () => {
    const state: FuelState = { lastTrustedPct: 70, window: null }
    const result = classifyFuel(0, state, ctx())
    expect(result.reading).toEqual({ value: 70, trust: 'suspect', readingTs: 1_000, arrivalTs: 1_010 })
    expect(result.anomalies).toEqual([]) // suspect-*entry* isn't itself logged; only reject/resolve are (AD-18)
    expect(state.window).toEqual({ openedAtReadingTs: 1_000, arrivalTsAtOpen: 1_010 })
  })

  it('FR-8c: 0% persisting past the suspect window resolves to trusted (real) and alerts, logged once', () => {
    const state: FuelState = { lastTrustedPct: 70, window: null }
    classifyFuel(0, state, ctx({ readingTs: 1_000, arrivalTs: 1_010 })) // opens the window

    const afterWindow = ctx({
      readingTs: 1_000 + CLIENT_THRESHOLDS.FUEL_SUSPECT_WINDOW_MS,
      arrivalTs: 1_010 + CLIENT_THRESHOLDS.FUEL_SUSPECT_WINDOW_MS,
    })
    const resolved = classifyFuel(0, state, afterWindow)
    expect(resolved.reading?.trust).toBe('trusted')
    expect(resolved.reading?.value).toBe(0)
    expect(resolved.anomalies).toEqual([
      { ruleId: 'fuel-suspect-resolved', truckId: 'truck_1', rawValue: 0, readingTs: 1_000, arrivalTs: 1_010 },
    ])
    expect(state.window).toBeNull()
    expect(state.lastTrustedPct).toBe(0)
  })

  it('FR-8: recovery inside the window resolves immediately (no artificial wait), no wall-clock timers involved', () => {
    const state: FuelState = { lastTrustedPct: 70, window: null }
    classifyFuel(0, state, ctx({ readingTs: 1_000, arrivalTs: 1_010 })) // opens the window

    const recoveryTs = 1_000 + 500 // well inside FUEL_SUSPECT_WINDOW_MS
    const recovered = classifyFuel(68, state, ctx({ readingTs: recoveryTs, arrivalTs: recoveryTs + 10 }))
    expect(recovered.reading).toEqual({ value: 68, trust: 'trusted', readingTs: recoveryTs, arrivalTs: recoveryTs + 10 })
    expect(recovered.anomalies).toEqual([
      { ruleId: 'fuel-suspect-resolved', truckId: 'truck_1', rawValue: 0, readingTs: 1_000, arrivalTs: 1_010 },
    ])
    expect(state.window).toBeNull()
    expect(state.lastTrustedPct).toBe(68)
  })

  it('a lone 0% reading with no prior trusted baseline (cold start) opens a pending window, no envelope yet (FR-5)', () => {
    const state = freshState()
    const result = classifyFuel(0, state, ctx())
    expect(result.reading).toBeNull()
    expect(result.anomalies).toEqual([])
    expect(state.window).not.toBeNull()
  })

  it('FR-6/FR-8: a stale 0% (older than the truck\'s current state) is handled by order.ts before reaching classify — never reopens a window here either way', () => {
    // This module only proves the classifier itself never mutates a
    // *different* already-open window when re-invoked with the same
    // truck's state bag in live mode for a genuinely new event; the
    // ordering guarantee itself is order.test.ts's job (FR-6 runs first).
    const state: FuelState = { lastTrustedPct: 70, window: { openedAtReadingTs: 5_000, arrivalTsAtOpen: 5_010 } }
    const before = { ...state.window }
    // A live reading that is NOT 0% and doesn't cross the window boundary
    // must not disturb the window's own open timestamp.
    classifyFuel(70, state, ctx({ readingTs: 5_100, arrivalTs: 5_110 }))
    expect(state.window).toBeNull() // recovered, cleared — but never "reopened" at a different timestamp
    expect(before).toEqual({ openedAtReadingTs: 5_000, arrivalTsAtOpen: 5_010 })
  })
})

describe('classifyFuel — backfill (stateless) mode', () => {
  it('never opens or mutates a window, and logs the full anomaly object by content (ruleId/truckId/rawValue/timestamps)', () => {
    const state: FuelState = { lastTrustedPct: 70, window: null }
    const result = classifyFuel(0, state, ctx({ mode: 'backfill' }))
    expect(state.window).toBeNull()
    expect(result.reading?.trust).toBe('trusted') // fails toward alerting (CM1) — no window to wait on
    expect(result.anomalies).toEqual([
      { ruleId: 'fuel-suspect-resolved', truckId: 'truck_1', rawValue: 0, readingTs: 1_000, arrivalTs: 1_010 },
    ])
  })

  it('branch (a) still short-circuits to trusted with no anomaly when the baseline is already low', () => {
    const state: FuelState = { lastTrustedPct: 5, window: null }
    const result = classifyFuel(0, state, ctx({ mode: 'backfill' }))
    expect(result.reading).toEqual({ value: 0, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_010 })
    expect(result.anomalies).toEqual([])
  })

  it('never mutates lastTrustedPct even for a non-zero reading', () => {
    const state: FuelState = { lastTrustedPct: 70, window: null }
    classifyFuel(55, state, ctx({ mode: 'backfill' }))
    expect(state.lastTrustedPct).toBe(70)
  })
})
