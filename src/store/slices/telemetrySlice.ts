// FleetPulse — telemetry slice: per-truck per-signal envelopes + bounded
// history (AD-15)
//
// The only place pipeline output lands for signal values. `latest` is the
// live-rendered envelope (untouched by a backfill-only commit); `history`
// is the per-signal, timestamp-sorted `boundedBuffer` feeding trails and
// charts (a GPS burst never evicts fuel/temp history because each signal
// gets its own buffer, not one shared collection).

import type { StateCreator } from 'zustand'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import { createBoundedBuffer, type BoundedBuffer } from '../boundedBuffer.ts'
import type { PipelineCommit } from '../../pipeline/index.ts'
import type { Reading, SignalName } from '../../pipeline/types.ts'
import type { FleetPulseStore } from '../store.ts'

export interface SignalTelemetry {
  latest: Reading<unknown> | null
  history: BoundedBuffer<Reading<unknown>>
}

export type TruckTelemetry = Partial<Record<SignalName, SignalTelemetry>>

export interface TelemetryState {
  trucks: Record<string, TruckTelemetry>
}

export interface TelemetrySlice {
  telemetry: TelemetryState
  /** Applies a batch of pipeline commits in one state update — the action
   * both direct callers and `store.ts`'s coalescing scheduler funnel
   * through (the scheduler calls `applyTelemetryCommitsPure` directly so
   * it can merge this with the obs slice into one `set()`). */
  applyTelemetryCommits: (commits: PipelineCommit[]) => void
  /** Wipes all telemetry (fleet_reset step 2 — AD-8); obs counters and the
   * session field live elsewhere and are unaffected. */
  resetTelemetry: () => void
}

function createSignalTelemetry(): SignalTelemetry {
  return {
    latest: null,
    history: createBoundedBuffer<Reading<unknown>>({
      cap: CLIENT_THRESHOLDS.TELEMETRY_HISTORY_CAP_PER_SIGNAL,
      orderingKey: (reading) => reading.readingTs,
    }),
  }
}

/** Pure reducer over telemetry state — exported so `store.ts`'s coalescing
 * scheduler can compute the next telemetry state without itself calling
 * `set()` (it merges this with the obs slice's own pure reducer into one
 * commit — AD-5). `boundedBuffer.push` mutates its own internal array in
 * place (by design, AD-10); everything at and above the per-signal record
 * is replaced with a fresh object so state consumers see a changed
 * reference. */
export function applyTelemetryCommitsPure(telemetry: TelemetryState, commits: readonly PipelineCommit[]): TelemetryState {
  if (commits.length === 0) return telemetry
  const trucks = { ...telemetry.trucks }

  for (const commit of commits) {
    const truck: TruckTelemetry = { ...trucks[commit.truckId] }
    for (const update of commit.signals) {
      const signalTelemetry = truck[update.signal] ?? createSignalTelemetry()
      for (const entry of update.historyEntries) signalTelemetry.history.push(entry)
      truck[update.signal] = {
        latest: update.live ?? signalTelemetry.latest,
        history: signalTelemetry.history,
      }
    }
    trucks[commit.truckId] = truck
  }

  return { trucks }
}

export const createTelemetrySlice: StateCreator<FleetPulseStore, [], [], TelemetrySlice> = (set) => ({
  telemetry: { trucks: {} },
  applyTelemetryCommits: (commits) =>
    set((state) => ({ telemetry: applyTelemetryCommitsPure(state.telemetry, commits) })),
  resetTelemetry: () => set({ telemetry: { trucks: {} } }),
})

/** Read-only lookup used by tests and by `selectors/effectiveTrust.ts`. */
export function selectSignalTelemetry(
  state: Pick<FleetPulseStore, 'telemetry'>,
  truckId: string,
  signal: SignalName,
): SignalTelemetry | undefined {
  return state.telemetry.trucks[truckId]?.[signal]
}
