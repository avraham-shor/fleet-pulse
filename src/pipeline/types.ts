// FleetPulse — pipeline domain types (AD-3)
//
// `pipeline/` imports only `contract/` and `shared/constants.js` (AD-1) — no
// store, no React, no DOM. These types are the pipeline's own vocabulary;
// `store/` imports them but the pipeline never imports back from `store/`.

/** Plausibility trust, assigned only in the pipeline (AD-3). Stale and
 * degraded are layered on top later by `store/selectors/effectiveTrust.ts`
 * — they are never assigned here. */
export type TrustState = 'trusted' | 'suspect' | 'sensor-fault'

/**
 * One signal's value crossing the pipeline boundary — one envelope per
 * signal (speed, fuel, temperature, position, mileage each carry their own;
 * FR-20). `readingTs` is when the sensor took the reading (drives ordering,
 * backfill, dedupe, the fuel suspect window); `arrivalTs` is when the client
 * accepted it (drives staleness only) — the two-clock rule (trust-model.md).
 */
export interface Reading<T> {
  value: T
  trust: TrustState
  readingTs: number
  arrivalTs: number
}

/** The five signals this story's registry carries. Extending this is a
 * registration (AD-6), not a change to this union in practice — but the
 * union itself lives here since every classifier needs to name its signal. */
export type SignalName = 'speed' | 'fuel' | 'position' | 'temperature' | 'mileage'

/**
 * One anomaly-log entry (AD-18): every rejection (sensor-fault) and every
 * suspect-window resolution emits exactly one of these. Raw rejected values
 * live only here — never in a `Reading<T>.value` a widget could render
 * (AD-3).
 */
export interface AnomalyEntry {
  ruleId: string
  truckId: string
  rawValue: unknown
  readingTs: number
  arrivalTs: number
}

/** Whether a given reading is driving the truck's live state (and may
 * mutate a classifier's persistent per-truck state, e.g. an open fuel
 * suspect window) or is a backfill entry — older than the truck's current
 * state, entering only bounded history under "stateless plausibility only"
 * classification (AD-4). */
export type IngestMode = 'live' | 'backfill'
