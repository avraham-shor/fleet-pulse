// FleetPulse — obs slice: anomaly log + transport counters passthrough
// (AD-18)
//
// The anomaly log is the one legal home for rejected/suspect-resolved raw
// values (AD-18) — the pipeline emits entries only through the batched
// commit and keeps no copy of its own. `transportCounters` is a thin
// passthrough for the dropped-message/reconnect/RTT numbers `sse-manager`
// and `ws-manager` already expose via their own getters (story 1.3) —
// nothing here polls them; a later story's `app/` composition root is what
// calls `setTransportCounters` from those getters.

import type { StateCreator } from 'zustand'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import { createBoundedBuffer, type BoundedBuffer } from '../boundedBuffer.ts'
import type { AnomalyEntry } from '../../pipeline/types.ts'
import type { FleetPulseStore } from '../store.ts'

export interface TransportCounters {
  sseDroppedMessages: number
  sseReconnects: number
  /** FR-30/story 10: sse-manager's rolling events/sec getter, polled onto
   * this passthrough the same way every other field here is — nothing in
   * this slice computes it. */
  sseEventsPerSecond: number
  wsDroppedMessages: number
  wsReconnects: number
  wsLastPingRttMs: number | null
}

export interface ObsState {
  anomalyLog: BoundedBuffer<AnomalyEntry>
  transportCounters: TransportCounters
}

export interface ObsSlice {
  obs: ObsState
  /** Appends a batch of anomaly entries in one state update — same
   * "direct action + pure-reducer for the coalescing scheduler" split as
   * the telemetry slice. No-op for an empty array. */
  pushAnomalies: (entries: AnomalyEntry[]) => void
  setTransportCounters: (patch: Partial<TransportCounters>) => void
  /** Wipes the anomaly log only — obs counters survive a fleet reset
   * (AD-18, AD-17). */
  resetObs: () => void
}

function createInitialTransportCounters(): TransportCounters {
  return {
    sseDroppedMessages: 0,
    sseReconnects: 0,
    sseEventsPerSecond: 0,
    wsDroppedMessages: 0,
    wsReconnects: 0,
    wsLastPingRttMs: null,
  }
}

function createAnomalyLog(): BoundedBuffer<AnomalyEntry> {
  return createBoundedBuffer<AnomalyEntry>({
    cap: CLIENT_THRESHOLDS.ANOMALY_LOG_CAP,
    orderingKey: (entry) => entry.readingTs,
  })
}

/** Pure reducer — see `applyTelemetryCommitsPure`'s docblock for why this
 * is exported separately from the `set()`-calling action. */
export function pushAnomaliesPure(obs: ObsState, entries: readonly AnomalyEntry[]): ObsState {
  if (entries.length === 0) return obs
  for (const entry of entries) obs.anomalyLog.push(entry)
  return { ...obs }
}

export const createObsSlice: StateCreator<FleetPulseStore, [], [], ObsSlice> = (set) => ({
  obs: { anomalyLog: createAnomalyLog(), transportCounters: createInitialTransportCounters() },
  pushAnomalies: (entries) => set((state) => ({ obs: pushAnomaliesPure(state.obs, entries) })),
  setTransportCounters: (patch) =>
    set((state) => ({ obs: { ...state.obs, transportCounters: { ...state.obs.transportCounters, ...patch } } })),
  resetObs: () => set((state) => ({ obs: { anomalyLog: createAnomalyLog(), transportCounters: state.obs.transportCounters } })),
})
