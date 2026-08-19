// FleetPulse — signal registry tests (AD-6)
//
// This file never imports `pipeline/index.ts` (or any concrete signal
// module) — Vitest gives each test file its own isolated module graph, so
// `registry.ts`'s module-level `Map` starts empty here regardless of what
// `speed.ts`/`fuel.ts`/`passthrough.ts` register elsewhere in the suite.

import { beforeEach, describe, expect, it } from 'vitest'
import { registerSignal, getRegisteredSignals, resetRegistryForTests, type ClassifyContext } from './registry.ts'
import type { SignalName } from '../types.ts'

function fakeSignal(name: SignalName) {
  return {
    name,
    extractRawValue: () => 0,
    createInitialState: () => undefined,
    classify: (value: number, _state: undefined, ctx: ClassifyContext) => ({
      reading: { value, trust: 'trusted' as const, readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs },
      anomalies: [],
    }),
  }
}

describe('signal registry', () => {
  beforeEach(() => {
    resetRegistryForTests()
  })

  it('AD-6: registerSignal makes a signal discoverable via getRegisteredSignals()', () => {
    expect(getRegisteredSignals()).toEqual([])
    const definition = fakeSignal('speed')
    registerSignal(definition)
    expect(getRegisteredSignals()).toEqual([definition])
  })

  it('AD-6: registering the same signal name twice throws instead of silently overwriting', () => {
    registerSignal(fakeSignal('fuel'))
    expect(() => registerSignal(fakeSignal('fuel'))).toThrow(/fuel/)
    // The original registration survives the failed second attempt.
    expect(getRegisteredSignals()).toHaveLength(1)
  })

  it('resetRegistryForTests() clears every registration', () => {
    registerSignal(fakeSignal('speed'))
    resetRegistryForTests()
    expect(getRegisteredSignals()).toEqual([])
  })
})
