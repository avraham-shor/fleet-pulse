// FleetPulse — always-trusted signals (position, temperature, mileage)
//
// No plausibility rule exists yet for these (story 4 Boundaries: "Position/
// temperature/mileage pass through always-trusted"). Fully stateless in
// both `live` and `backfill` mode — there is no per-truck state to keep.

import type { TelemetryReading } from '../../contract/telemetry.ts'
import { registerSignal, type ClassifyContext, type ClassifyResult } from './registry.ts'
import type { SignalName } from '../types.ts'

export interface Position {
  lat: number
  lng: number
}

function makePassthroughSignal<T>(name: SignalName, extractRawValue: (reading: TelemetryReading) => T) {
  function classify(value: T, _state: undefined, ctx: ClassifyContext): ClassifyResult<T> {
    return { reading: { value, trust: 'trusted', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs }, anomalies: [] }
  }
  registerSignal<T, undefined>({
    name,
    extractRawValue,
    createInitialState: () => undefined,
    classify,
  })
}

makePassthroughSignal<Position>('position', (reading) => ({ lat: reading.lat, lng: reading.lng }))
makePassthroughSignal<number>('temperature', (reading) => reading.engineTemp)
makePassthroughSignal<number>('mileage', (reading) => reading.mileage)
