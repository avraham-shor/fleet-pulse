// FleetPulse — obs slice tests (AD-18)

import { describe, expect, it } from 'vitest'
import { createFleetPulseStore } from '../store.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'

describe('obsSlice', () => {
  it('FR-9: pushAnomalies appends entries to the bounded anomaly log', () => {
    const store = createFleetPulseStore()
    store.getState().pushAnomalies([{ ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 999, readingTs: 1_000, arrivalTs: 1_010 }])
    expect(store.getState().obs.anomalyLog.toArray()).toHaveLength(1)
  })

  it('NFR-3: the anomaly log never exceeds ANOMALY_LOG_CAP', () => {
    const store = createFleetPulseStore()
    const cap = CLIENT_THRESHOLDS.ANOMALY_LOG_CAP
    for (let i = 0; i < cap + 20; i++) {
      store.getState().pushAnomalies([{ ruleId: 'fuel-suspect-resolved', truckId: 'truck_1', rawValue: 0, readingTs: i, arrivalTs: i }])
    }
    expect(store.getState().obs.anomalyLog.size()).toBe(cap)
  })

  it('setTransportCounters merges a partial patch', () => {
    const store = createFleetPulseStore()
    store.getState().setTransportCounters({ sseDroppedMessages: 3 })
    store.getState().setTransportCounters({ wsReconnects: 2 })
    expect(store.getState().obs.transportCounters).toMatchObject({ sseDroppedMessages: 3, wsReconnects: 2 })
  })

  it('AD-18/AD-17: resetObs wipes the anomaly log but obs counters survive', () => {
    const store = createFleetPulseStore()
    store.getState().pushAnomalies([{ ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 999, readingTs: 1_000, arrivalTs: 1_010 }])
    store.getState().setTransportCounters({ sseDroppedMessages: 5 })
    store.getState().resetObs()
    expect(store.getState().obs.anomalyLog.toArray()).toEqual([])
    expect(store.getState().obs.transportCounters.sseDroppedMessages).toBe(5)
  })
})
