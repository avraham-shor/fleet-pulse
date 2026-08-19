// FleetPulse — pipeline integration tests (AD-1, AD-4)
//
// Exercises `createPipeline({onCommit, onAnomaly})` end to end: ingest ->
// order/dedupe -> classify -> one batched commit per call. Runs in the
// node environment (no React/DOM) with direct callback injection — the
// seam this story's Design Notes call for, since `app/` doesn't exist yet.

import { describe, expect, it } from 'vitest'
import { createPipeline, type PipelineCommit, type SignalUpdate } from './index.ts'
import type { AnomalyEntry, Reading } from './types.ts'
import type { TelemetryBatch, TelemetryReading } from '../contract/telemetry.ts'
import { CLIENT_THRESHOLDS, SERVER_PARAMS } from '../../shared/constants.js'

function makeReading(overrides: Partial<TelemetryReading> = {}): TelemetryReading {
  return {
    truckId: 'truck_1',
    timestamp: 0,
    lat: 32.1,
    lng: 34.8,
    speed: 40,
    fuel: 70,
    engineTemp: 75,
    mileage: 1_000,
    ...overrides,
  }
}

function findSignal(commit: PipelineCommit, signal: SignalUpdate['signal']): SignalUpdate | undefined {
  return commit.signals.find((s) => s.signal === signal)
}

function setup() {
  const commits: PipelineCommit[] = []
  const anomalyBatches: AnomalyEntry[][] = []
  let clock = 0
  const pipeline = createPipeline({
    onCommit: (c) => commits.push(c),
    onAnomaly: (a) => anomalyBatches.push(a),
    now: () => clock,
  })
  return { pipeline, commits, anomalyBatches, setClock: (ms: number) => (clock = ms) }
}

describe('createPipeline — ingest', () => {
  it('FR-6: a reading older than the truck\'s current state never overwrites live state, still lands in sorted bounded history, still classified', () => {
    const { pipeline, commits } = setup()
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 5_000, speed: 50 })] })
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 3_000, speed: 30 })] })

    const lastCommit = commits[commits.length - 1]!
    const speed = findSignal(lastCommit, 'speed')!
    expect(speed.live).toBeNull() // never overwrites the newer live state
    expect(speed.historyEntries).toHaveLength(1)
    expect(speed.historyEntries[0]).toMatchObject({ value: 30, trust: 'trusted', readingTs: 3_000 })
  })

  it('FR-6/NFR-2: a 30-reading GPS batch with a non-monotonic interior order commits within the batch-processing budget, ordered by timestamp', () => {
    const { pipeline, commits } = setup()
    const size = SERVER_PARAMS.GPS_BATCH_SIZE_MAX
    const readings: TelemetryReading[] = []
    for (let i = 0; i < size; i++) {
      readings.push(
        makeReading({
          truckId: 'truck_2',
          timestamp: i * SERVER_PARAMS.TELEMETRY_TICK_MS,
          lat: 32 + i * 0.001,
          lng: 34 + i * 0.001,
        }),
      )
    }
    // One adjacent interior swap — mirrors server.js's own occasional
    // non-monotonic entry (Code Map: buildBatchEmission), excluding the
    // last (truly newest) index.
    const idx = 10
    const swapped: [TelemetryReading, TelemetryReading] = [readings[idx - 1]!, readings[idx]!]
    readings[idx] = swapped[0]
    readings[idx - 1] = swapped[1]

    const batch: TelemetryBatch = { truckId: 'truck_2', readings }
    const start = performance.now()
    pipeline.ingest(batch)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(CLIENT_THRESHOLDS.BATCH_PROCESSING_BUDGET_MS)

    const commit = commits[commits.length - 1]!
    const position = findSignal(commit, 'position')!
    expect(position.historyEntries).toHaveLength(size) // full batch enters history
    expect(position.live).toEqual({
      value: { lat: readings[size - 1]!.lat, lng: readings[size - 1]!.lng },
      trust: 'trusted',
      readingTs: readings[size - 1]!.timestamp,
      arrivalTs: 0,
    })
    // Never a partial apply: exactly one commit for the whole batch.
    expect(commits).toHaveLength(1)
  })

  it('FR-7: speed = 999 classifies as sensor-fault and is forwarded to onAnomaly with the raw value', () => {
    const { pipeline, commits, anomalyBatches } = setup()
    pipeline.ingest({ truckId: 'truck_7', readings: [makeReading({ truckId: 'truck_7', timestamp: 1_000, speed: 60 })] })
    pipeline.ingest({ truckId: 'truck_7', readings: [makeReading({ truckId: 'truck_7', timestamp: 2_000, speed: 999 })] })

    const commit = commits[commits.length - 1]!
    const speed = findSignal(commit, 'speed')!
    expect(speed.live).toMatchObject({ value: 60, trust: 'sensor-fault' })
    expect(anomalyBatches[anomalyBatches.length - 1]).toEqual([
      { ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 999, readingTs: 2_000, arrivalTs: 0 },
    ])
  })

  it('FR-8: a fuel cliff-drop followed by recovery within the same batch resolves immediately, no artificial wait', () => {
    const { pipeline, commits, anomalyBatches } = setup()
    const readings = [
      makeReading({ timestamp: 0, fuel: 70 }),
      makeReading({ timestamp: 100, fuel: 0 }),
      makeReading({ timestamp: 300, fuel: 0 }),
      makeReading({ timestamp: 700, fuel: 65 }),
    ]
    expect(readings[readings.length - 1]!.timestamp).toBeLessThan(CLIENT_THRESHOLDS.FUEL_SUSPECT_WINDOW_MS)

    pipeline.ingest({ truckId: 'truck_1', readings })

    expect(commits).toHaveLength(1) // one batched commit, per AD-4
    const fuel = findSignal(commits[0]!, 'fuel')!
    expect(fuel.live).toMatchObject({ value: 65, trust: 'trusted' })
    expect(anomalyBatches).toHaveLength(1)
    expect(anomalyBatches[0]).toEqual([
      { ruleId: 'fuel-suspect-resolved', truckId: 'truck_1', rawValue: 0, readingTs: 100, arrivalTs: 0 },
    ])
  })

  it('FR-8c: fuel 0% persisting past the suspect window (across two ingest calls) resolves to trusted and alerts', () => {
    const { pipeline, commits, anomalyBatches, setClock } = setup()
    setClock(0)
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 0, fuel: 70 })] })
    setClock(10)
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 100, fuel: 0 })] }) // opens window

    setClock(6_000)
    pipeline.ingest({
      truckId: 'truck_1',
      readings: [makeReading({ timestamp: 100 + CLIENT_THRESHOLDS.FUEL_SUSPECT_WINDOW_MS, fuel: 0 })],
    })

    const fuel = findSignal(commits[commits.length - 1]!, 'fuel')!
    expect(fuel.live).toMatchObject({ value: 0, trust: 'trusted' })
    expect(anomalyBatches[anomalyBatches.length - 1]).toEqual([
      { ruleId: 'fuel-suspect-resolved', truckId: 'truck_1', rawValue: 0, readingTs: 100, arrivalTs: 10 },
    ])
  })

  it('FR-6+FR-8: a stale 0% (older than the truck\'s current state) never reopens or disturbs an already-open suspect window', () => {
    const { pipeline, commits } = setup()
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 10_000, fuel: 70 })] })
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 11_000, fuel: 0 })] }) // opens window @ 11_000

    // A stale 0%, older than the current cursor (11_000) — order.ts tags
    // this backfill; it must never touch the live window's schedule.
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 9_000, fuel: 0 })] })

    // Just before the *original* window (opened at 11_000) would elapse —
    // if the stale reading had reset/extended it, this would already have
    // resolved or would resolve at the wrong time. It must still be suspect.
    pipeline.ingest({
      truckId: 'truck_1',
      readings: [makeReading({ timestamp: 11_000 + CLIENT_THRESHOLDS.FUEL_SUSPECT_WINDOW_MS - 1, fuel: 0 })],
    })
    const stillSuspect = findSignal(commits[commits.length - 1]!, 'fuel')!
    expect(stillSuspect.live).toMatchObject({ trust: 'suspect', value: 70 })

    // Exactly at the original window boundary, it resolves.
    pipeline.ingest({
      truckId: 'truck_1',
      readings: [makeReading({ timestamp: 11_000 + CLIENT_THRESHOLDS.FUEL_SUSPECT_WINDOW_MS, fuel: 0 })],
    })
    const resolved = findSignal(commits[commits.length - 1]!, 'fuel')!
    expect(resolved.live).toMatchObject({ trust: 'trusted', value: 0 })
  })

  it('position/temperature/mileage pass through always-trusted', () => {
    const { pipeline, commits } = setup()
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 1_000, engineTemp: 210, mileage: 5_000 })] })
    const commit = commits[0]!
    expect(findSignal(commit, 'temperature')!.live).toMatchObject({ value: 210, trust: 'trusted' })
    expect(findSignal(commit, 'mileage')!.live).toMatchObject({ value: 5_000, trust: 'trusted' })
  })

  it('an empty readings array produces zero commits (mirrors ingestBackfill([]))', () => {
    const { pipeline, commits, anomalyBatches } = setup()
    pipeline.ingest({ truckId: 'truck_1', readings: [] })
    expect(commits).toHaveLength(0)
    expect(anomalyBatches).toHaveLength(0)
  })
})

describe('createPipeline — ingestBackfill', () => {
  it('AD-15: never updates live state, only enters bounded history, still classified', () => {
    const { pipeline, commits } = setup()
    pipeline.ingestBackfill([
      makeReading({ timestamp: 1_000, speed: 40 }),
      makeReading({ timestamp: 2_000, speed: 999 }), // would be a fault, but no baseline yet -> no envelope
      makeReading({ timestamp: 3_000, speed: 45 }),
    ])
    const commit = commits[0]!
    const speed = findSignal(commit, 'speed')!
    expect(speed.live).toBeNull()
    // Only 2 of the 3 readings produce an envelope: the fault has no prior
    // plausible baseline within this backfill call yet.
    expect(speed.historyEntries.map((r: Reading<unknown>) => r.value)).toEqual([40, 45])
  })

  it('groups mixed-truck readings into one commit per truck', () => {
    const { pipeline, commits } = setup()
    pipeline.ingestBackfill([
      makeReading({ truckId: 'truck_a', timestamp: 1_000 }),
      makeReading({ truckId: 'truck_b', timestamp: 1_000 }),
    ])
    expect(commits.map((c) => c.truckId).sort()).toEqual(['truck_a', 'truck_b'])
  })
})

describe('createPipeline — reset', () => {
  it('drops per-truck cursors and open windows — a reading that would have been backfill pre-reset is live post-reset', () => {
    const { pipeline, commits } = setup()
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 10_000 })] })
    pipeline.reset()
    pipeline.ingest({ truckId: 'truck_1', readings: [makeReading({ timestamp: 1_000 })] })

    const commit = commits[commits.length - 1]!
    expect(findSignal(commit, 'speed')!.live).not.toBeNull()
  })
})
