// FleetPulse — pipeline public factory (AD-1, AD-4)
//
// `createPipeline({onCommit, onAnomaly})` is the one seam `pipeline/`
// exposes. `ingest`/`ingestBackfill`/`reset` are what a later story's
// `app/` composition root wires to `sse-manager.onBatch`, the history
// endpoint, and `fleet_reset` respectively (AD-1) — this story proves the
// seam correct via direct injection in its own tests (Design Notes).
//
// Importing the concrete signal modules here (for their `registerSignal`
// side effect) is the one place a *new* signal's registration gets wired
// in — adding one is a new module under `signals/` plus one import line
// here, never an edit to an existing classifier (AD-6).
import './signals/speed.ts'
import './signals/fuel.ts'
import './signals/passthrough.ts'

import type { TelemetryBatch, TelemetryReading } from '../contract/telemetry.ts'
import type { AnomalyEntry, Reading, SignalName } from './types.ts'
import { createTruckCursor, orderReadings, type TruckCursor } from './order.ts'
import { getRegisteredSignals, type ClassifyContext } from './signals/registry.ts'

/** One signal's fallout from one `ingest`/`ingestBackfill` call for one
 * truck: the (possibly unchanged) live envelope, plus every reading that
 * should land in that signal's bounded history — live and backfill alike
 * (AD-4: "every history entry carries real trust"). */
export interface SignalUpdate {
  signal: SignalName
  /** Non-null only when a `live` reading produced an envelope this call —
   * the store applies this to the signal's current value. `null` means no
   * live update happened (e.g. every reading in this call was backfill, or
   * classification produced no trustworthy value yet). */
  live: Reading<unknown> | null
  /** In arrival order within this call — the store's `boundedBuffer`
   * handles sorted insertion (AD-10), so this stage never sorts twice. */
  historyEntries: Reading<unknown>[]
}

/** One batched commit per `ingest`/`ingestBackfill` call (AD-4's "one
 * batched store commit"; AD-5 coalesces these further at the store). */
export interface PipelineCommit {
  truckId: string
  signals: SignalUpdate[]
}

export interface CreatePipelineOptions {
  onCommit: (commit: PipelineCommit) => void
  /** Called once per `ingest`/`ingestBackfill` call that produced at least
   * one anomaly — never called with an empty array. */
  onAnomaly: (entries: AnomalyEntry[]) => void
  /** Clock for `arrivalTs` — one reading per call across every reading in
   * the same frame/backfill payload, since they all arrived together.
   * Defaults to `Date.now`; injectable for tests. */
  now?: () => number
}

export interface Pipeline {
  /** The live seam: one SSE frame's worth of readings for one truck. */
  ingest(batch: TelemetryBatch): void
  /** The backfill seam: history-endpoint readings for one or more trucks,
   * always classified in stateless mode and never applied to live state
   * (AD-15) — grouped by `truckId` internally. */
  ingestBackfill(readings: readonly TelemetryReading[]): void
  /** Drops every per-truck cursor, dedupe/ordering state, and open suspect
   * window — step 1 of the `fleet_reset` sequence AD-8 describes (owned by
   * `app/`, not this module). */
  reset(): void
}

interface TruckPipelineState {
  cursor: TruckCursor
  signalStates: Map<SignalName, unknown>
}

export function createPipeline(options: CreatePipelineOptions): Pipeline {
  const now = options.now ?? Date.now
  const truckStates = new Map<string, TruckPipelineState>()

  function getOrCreateTruckState(truckId: string): TruckPipelineState {
    let state = truckStates.get(truckId)
    if (!state) {
      state = { cursor: createTruckCursor(), signalStates: new Map() }
      for (const signal of getRegisteredSignals()) {
        state.signalStates.set(signal.name, signal.createInitialState())
      }
      truckStates.set(truckId, state)
    }
    return state
  }

  function classifyOneReading(
    truckId: string,
    reading: TelemetryReading,
    mode: ClassifyContext['mode'],
    arrivalTs: number,
    truckState: TruckPipelineState,
    signalUpdates: Map<SignalName, SignalUpdate>,
    anomalies: AnomalyEntry[],
  ): void {
    const ctx: ClassifyContext = { truckId, readingTs: reading.timestamp, arrivalTs, mode }
    for (const signal of getRegisteredSignals()) {
      const signalState = truckState.signalStates.get(signal.name)
      const rawValue = signal.extractRawValue(reading)
      const result = signal.classify(rawValue, signalState, ctx)
      if (result.anomalies.length > 0) anomalies.push(...result.anomalies)
      if (result.reading === null) continue

      let update = signalUpdates.get(signal.name)
      if (!update) {
        update = { signal: signal.name, live: null, historyEntries: [] }
        signalUpdates.set(signal.name, update)
      }
      update.historyEntries.push(result.reading)
      if (mode === 'live') update.live = result.reading
    }
  }

  function commitTruck(truckId: string, signalUpdates: Map<SignalName, SignalUpdate>, anomalies: AnomalyEntry[]): void {
    options.onCommit({ truckId, signals: [...signalUpdates.values()] })
    if (anomalies.length > 0) options.onAnomaly(anomalies)
  }

  function ingest(batch: TelemetryBatch): void {
    // A malformed/empty batch produces no readings to classify — nothing
    // changed, so nothing commits (mirrors `ingestBackfill([])`, whose
    // `byTruck` grouping loop naturally never runs for empty input). An
    // empty-signals commit would otherwise still churn a new object
    // identity through `applyTelemetryCommitsPure` for zero actual change.
    if (batch.readings.length === 0) return
    const truckState = getOrCreateTruckState(batch.truckId)
    const ordered = orderReadings(batch.readings, truckState.cursor)
    const signalUpdates = new Map<SignalName, SignalUpdate>()
    const anomalies: AnomalyEntry[] = []
    const arrivalTs = now()

    for (const { reading, mode } of ordered) {
      classifyOneReading(batch.truckId, reading, mode, arrivalTs, truckState, signalUpdates, anomalies)
    }

    commitTruck(batch.truckId, signalUpdates, anomalies)
  }

  function ingestBackfill(readings: readonly TelemetryReading[]): void {
    const byTruck = new Map<string, TelemetryReading[]>()
    for (const reading of readings) {
      const list = byTruck.get(reading.truckId)
      if (list) list.push(reading)
      else byTruck.set(reading.truckId, [reading])
    }

    const arrivalTs = now()
    for (const [truckId, truckReadings] of byTruck) {
      const truckState = getOrCreateTruckState(truckId)
      const signalUpdates = new Map<SignalName, SignalUpdate>()
      const anomalies: AnomalyEntry[] = []
      // Sorted for a deterministic, timestamp-ordered history insertion —
      // backfill never touches the live cursor, so there's no "working
      // cursor" to advance here (order.ts's job is specific to the live
      // seam).
      const sorted = [...truckReadings].sort((a, b) => a.timestamp - b.timestamp)
      for (const reading of sorted) {
        classifyOneReading(truckId, reading, 'backfill', arrivalTs, truckState, signalUpdates, anomalies)
      }
      commitTruck(truckId, signalUpdates, anomalies)
    }
  }

  function reset(): void {
    truckStates.clear()
  }

  return { ingest, ingestBackfill, reset }
}
