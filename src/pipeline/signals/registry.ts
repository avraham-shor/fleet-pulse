// FleetPulse — signal/anomaly-rule registry (AD-6)
//
// One registry serves both roles the spine names (telemetry signals,
// anomaly rules): each classifier's rejection/suspect-resolution path *is*
// its anomaly rule, so there is nothing distinct for a second registry to
// hold (story 4 Design Notes). Adding a signal is one new module in this
// directory that calls `registerSignal()` once at load time, plus one
// import line where signals are collected (`pipeline/index.ts`) — never an
// edit to an existing classifier module.

import type { TelemetryReading } from '../../contract/telemetry.ts'
import type { AnomalyEntry, IngestMode, Reading, SignalName } from '../types.ts'

/** Everything a classifier needs about the reading it's classifying, aside
 * from the raw value itself. */
export interface ClassifyContext {
  truckId: string
  readingTs: number
  arrivalTs: number
  /** `live` = this reading is advancing the truck's cursor; the classifier
   * may read *and* mutate its own per-truck `state`. `backfill` = older
   * than the truck's current state; the classifier may only read `state`
   * ("stateless plausibility only", AD-4) — mutating it here would let a
   * backfill entry retroactively affect live classification. */
  mode: IngestMode
}

export interface ClassifyResult<T> {
  /** The envelope this classification produces, or `null` when there is
   * nothing trustworthy to show yet (FR-5 cold start — e.g. a sensor-fault
   * or suspect reading with no prior plausible/trusted baseline to fall
   * back to). */
  reading: Reading<T> | null
  /** Zero or more anomaly-log entries this classification produced —
   * rejected values and suspect-window resolutions (AD-18). Almost always
   * 0 or 1; never mutated after return. */
  anomalies: AnomalyEntry[]
}

/**
 * One registered signal: how to pull its raw value out of a wire reading,
 * how to classify it, and how to create the classifier's own private
 * per-truck state bag (opaque to the pipeline core — AD-6 extensibility:
 * a new signal's state shape never has to fit an existing mold).
 */
export interface SignalDefinition<T, S> {
  name: SignalName
  extractRawValue(reading: TelemetryReading): T
  createInitialState(): S
  classify(rawValue: T, state: S, ctx: ClassifyContext): ClassifyResult<T>
}

// `unknown, unknown` here is the registry's own storage type — each
// `registerSignal` call still gets full type safety at its call site via
// the generic parameter on `SignalDefinition` itself.
const registry = new Map<SignalName, SignalDefinition<unknown, unknown>>()

export function registerSignal<T, S>(definition: SignalDefinition<T, S>): void {
  // AD-6's extensibility promise ("new module + one register() call") only
  // holds if a name collision fails loudly — a silent overwrite here would
  // leave whichever classifier registered second quietly shadowing the
  // first, an easy bug to miss during review.
  if (registry.has(definition.name)) {
    throw new Error(`signal "${definition.name}" is already registered`)
  }
  registry.set(definition.name, definition as SignalDefinition<unknown, unknown>)
}

export function getRegisteredSignals(): SignalDefinition<unknown, unknown>[] {
  return [...registry.values()]
}

/** Test-only: clears every registration. Production code never calls this
 * — signal modules register once at import time and stay registered for
 * the process lifetime. */
export function resetRegistryForTests(): void {
  registry.clear()
}
