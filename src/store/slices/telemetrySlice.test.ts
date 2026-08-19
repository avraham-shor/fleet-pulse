// FleetPulse — telemetry slice tests (AD-15)

import { describe, expect, it } from 'vitest'
import { createFleetPulseStore } from '../store.ts'
import { selectSignalTelemetry } from './telemetrySlice.ts'
import type { PipelineCommit } from '../../pipeline/index.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'

describe('telemetrySlice', () => {
  it('applies a live update and appends to the per-signal bounded history', () => {
    const store = createFleetPulseStore()
    const commit: PipelineCommit = {
      truckId: 'truck_1',
      signals: [
        {
          signal: 'speed',
          live: { value: 42, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_010 },
          historyEntries: [{ value: 42, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_010 }],
        },
      ],
    }
    store.getState().applyTelemetryCommits([commit])
    const signal = selectSignalTelemetry(store.getState(), 'truck_1', 'speed')
    expect(signal?.latest).toEqual({ value: 42, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_010 })
    expect(signal?.history.toArray()).toHaveLength(1)
  })

  it('a backfill-only update (live: null) leaves latest untouched but grows history', () => {
    const store = createFleetPulseStore()
    store.getState().applyTelemetryCommits([
      {
        truckId: 'truck_1',
        signals: [
          {
            signal: 'speed',
            live: { value: 42, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_010 },
            historyEntries: [{ value: 42, trust: 'trusted', readingTs: 1_000, arrivalTs: 1_010 }],
          },
        ],
      },
    ])
    store.getState().applyTelemetryCommits([
      {
        truckId: 'truck_1',
        signals: [
          { signal: 'speed', live: null, historyEntries: [{ value: 10, trust: 'trusted', readingTs: 500, arrivalTs: 1_010 }] },
        ],
      },
    ])
    const signal = selectSignalTelemetry(store.getState(), 'truck_1', 'speed')
    expect(signal?.latest?.value).toBe(42) // untouched
    expect(signal?.history.toArray()).toHaveLength(2)
  })

  it('NFR-3: history never exceeds TELEMETRY_HISTORY_CAP_PER_SIGNAL', () => {
    const store = createFleetPulseStore()
    const cap = CLIENT_THRESHOLDS.TELEMETRY_HISTORY_CAP_PER_SIGNAL
    for (let i = 0; i < cap + 10; i++) {
      store.getState().applyTelemetryCommits([
        {
          truckId: 'truck_1',
          signals: [
            {
              signal: 'speed',
              live: { value: i, trust: 'trusted', readingTs: i, arrivalTs: i },
              historyEntries: [{ value: i, trust: 'trusted', readingTs: i, arrivalTs: i }],
            },
          ],
        },
      ])
    }
    const signal = selectSignalTelemetry(store.getState(), 'truck_1', 'speed')
    expect(signal?.history.size()).toBe(cap)
  })

  it('a GPS burst never evicts fuel/temp history — each signal owns its own buffer', () => {
    const store = createFleetPulseStore()
    const cap = CLIENT_THRESHOLDS.TELEMETRY_HISTORY_CAP_PER_SIGNAL
    store.getState().applyTelemetryCommits([
      {
        truckId: 'truck_1',
        signals: [
          { signal: 'fuel', live: { value: 70, trust: 'trusted', readingTs: 0, arrivalTs: 0 }, historyEntries: [{ value: 70, trust: 'trusted', readingTs: 0, arrivalTs: 0 }] },
        ],
      },
    ])
    const positionUpdates = Array.from({ length: cap + 50 }, (_, i) => ({
      value: { lat: i, lng: i },
      trust: 'trusted' as const,
      readingTs: i,
      arrivalTs: i,
    }))
    store.getState().applyTelemetryCommits([
      { truckId: 'truck_1', signals: [{ signal: 'position', live: positionUpdates.at(-1)!, historyEntries: positionUpdates }] },
    ])
    expect(selectSignalTelemetry(store.getState(), 'truck_1', 'position')?.history.size()).toBe(cap)
    expect(selectSignalTelemetry(store.getState(), 'truck_1', 'fuel')?.history.size()).toBe(1)
  })

  it('resetTelemetry wipes all truck telemetry', () => {
    const store = createFleetPulseStore()
    store.getState().applyTelemetryCommits([
      {
        truckId: 'truck_1',
        signals: [{ signal: 'speed', live: { value: 1, trust: 'trusted', readingTs: 0, arrivalTs: 0 }, historyEntries: [] }],
      },
    ])
    store.getState().resetTelemetry()
    expect(selectSignalTelemetry(store.getState(), 'truck_1', 'speed')).toBeUndefined()
  })
})
