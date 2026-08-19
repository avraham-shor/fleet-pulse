// FleetPulse — coalescing commit scheduler tests (AD-5, NFR-1)
//
// Node environment, vitest fake timers — same convention as
// transport/ws-manager.test.ts and sse-manager.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { createCoalescingCommitScheduler, createFleetPulseStore } from './store.ts'
import { selectSignalTelemetry } from './slices/telemetrySlice.ts'
import type { PipelineCommit } from '../pipeline/index.ts'
import { CLIENT_THRESHOLDS, SERVER_PARAMS } from '../../shared/constants.js'

describe('createCoalescingCommitScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('NFR-1: 12 trucks x 2s ticks synthetic burst — committed-state count stays within RENDER_COALESCE_MAX_COMMITS_PER_SEC, nothing dropped', () => {
    const store = createFleetPulseStore()
    const scheduler = createCoalescingCommitScheduler(store)

    let commitCount = 0
    const unsubscribe = store.subscribe(() => {
      commitCount += 1
    })

    const TRUCK_COUNT = 12
    const TOTAL_MS = SERVER_PARAMS.TELEMETRY_TICK_MS * 2 // two full telemetry ticks
    const STEP_MS = 5 // far denser than the real 2s tick — a synthetic flood
    let lastValueForTruck0 = -1

    for (let elapsed = 0; elapsed < TOTAL_MS; elapsed += STEP_MS) {
      for (let truck = 0; truck < TRUCK_COUNT; truck++) {
        const value = elapsed * TRUCK_COUNT + truck
        const commit: PipelineCommit = {
          truckId: `truck_${truck}`,
          signals: [
            {
              signal: 'speed',
              live: { value, trust: 'trusted', readingTs: elapsed, arrivalTs: elapsed },
              historyEntries: [{ value, trust: 'trusted', readingTs: elapsed, arrivalTs: elapsed }],
            },
          ],
        }
        scheduler.ingestPipelineCommit(commit)
        if (truck === 0) lastValueForTruck0 = value
      }
      vi.advanceTimersByTime(STEP_MS)
    }
    scheduler.flushNow() // drain anything still pending at the end

    const elapsedSeconds = TOTAL_MS / 1_000
    // A couple of ms of scheduling slop either side of the fixed cadence
    // (plus flushNow's own possible extra commit) shouldn't fail this —
    // the point is proving order-of-magnitude coalescing against the
    // ceiling, not asserting an exact flush count.
    const maxAllowedCommits = Math.ceil(CLIENT_THRESHOLDS.RENDER_COALESCE_MAX_COMMITS_PER_SEC * elapsedSeconds) + 2
    const totalEnqueued = (TOTAL_MS / STEP_MS) * TRUCK_COUNT
    expect(commitCount).toBeLessThanOrEqual(maxAllowedCommits)
    expect(commitCount).toBeGreaterThan(0) // coalesced, not silently dropped entirely
    expect(commitCount).toBeLessThan(totalEnqueued) // meaningfully coalesced, not one commit per enqueue

    // Coalesced, not dropped: the very last enqueued value for truck_0 made
    // it into the store despite the flood being merged into far fewer commits.
    const finalSpeed = selectSignalTelemetry(store.getState(), 'truck_0', 'speed')
    expect(finalSpeed?.latest?.value).toBe(lastValueForTruck0)

    unsubscribe()
  })

  it('flushes both pending telemetry commits and pending anomalies together in one set() call', () => {
    const store = createFleetPulseStore()
    const scheduler = createCoalescingCommitScheduler(store)
    let commitCount = 0
    store.subscribe(() => {
      commitCount += 1
    })

    scheduler.ingestPipelineCommit({
      truckId: 'truck_1',
      signals: [{ signal: 'speed', live: { value: 999, trust: 'sensor-fault', readingTs: 0, arrivalTs: 0 }, historyEntries: [] }],
    })
    scheduler.ingestAnomalies([{ ruleId: 'speed-sensor-fault', truckId: 'truck_1', rawValue: 999, readingTs: 0, arrivalTs: 0 }])

    vi.advanceTimersByTime(1_000 / CLIENT_THRESHOLDS.RENDER_COALESCE_MAX_COMMITS_PER_SEC)

    expect(commitCount).toBe(1)
    expect(store.getState().obs.anomalyLog.toArray()).toHaveLength(1)
    expect(selectSignalTelemetry(store.getState(), 'truck_1', 'speed')?.latest?.trust).toBe('sensor-fault')
  })

  it('ingestAnomalies is a no-op for an empty array (never schedules a needless flush)', () => {
    const store = createFleetPulseStore()
    const scheduler = createCoalescingCommitScheduler(store)
    let commitCount = 0
    store.subscribe(() => {
      commitCount += 1
    })
    scheduler.ingestAnomalies([])
    vi.advanceTimersByTime(10_000)
    expect(commitCount).toBe(0)
  })
})
