// FleetPulse — fuel classifier (FR-8, hybrid policy)
//
// A 0% reading is a question, not a value (trust-model.md):
//   (a) prior trusted level already <= FUEL_ALREADY_LOW_PCT -> plausible,
//       trusted, alerts immediately.
//   (b) cliff-drop from a healthy level -> suspect: last trusted value
//       shown with a "validating" badge while a window runs.
//   (c) 0% persisting past FUEL_SUSPECT_WINDOW_MS (measured in reading
//       timestamps, never wall-clock) -> accepted as real, trusted, alerts.
//
// The window is *lazily* resolved: there are no wall-clock timers in this
// module (I/O matrix: "no wall-clock timers used for this path"). Instead,
// every subsequent `live` reading for the truck (any signal — they all
// share one `readingTs`, since `classify` runs once per registered signal
// per wire reading) first checks whether enough reading-timestamp time has
// elapsed since the window opened; if so it resolves the window *before*
// classifying the new value. A batch processed in-order within one
// `ingest()` call therefore resolves recovery-inside-the-window
// synchronously, with no artificial wait (I/O matrix, FR-8).
//
// `backfill` (stateless) mode never opens or mutates a window (AD-4) — a
// historical 0% reading it encounters is resolved on the spot using the
// same "no further readings at all" rule (c) applies to a live window that
// never got a chance to run: CM1's fail-toward-alerting tie-break, applied
// consistently rather than inventing a parallel rule for the stateless case.

import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { AnomalyEntry } from '../types.ts'
import { registerSignal, type ClassifyContext, type ClassifyResult } from './registry.ts'

export interface FuelState {
  lastTrustedPct: number | null
  window: { openedAtReadingTs: number; arrivalTsAtOpen: number } | null
}

function suspectResolvedAnomaly(truckId: string, state: FuelState): AnomalyEntry {
  const openedAt = state.window
  return {
    ruleId: 'fuel-suspect-resolved',
    truckId,
    rawValue: 0,
    readingTs: openedAt ? openedAt.openedAtReadingTs : 0,
    arrivalTs: openedAt ? openedAt.arrivalTsAtOpen : 0,
  }
}

function classifyFuelBackfill(valuePct: number, state: FuelState, ctx: ClassifyContext): ClassifyResult<number> {
  if (valuePct !== 0) {
    return { reading: { value: valuePct, trust: 'trusted', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs }, anomalies: [] }
  }
  const baseline = state.lastTrustedPct
  if (baseline !== null && baseline <= CLIENT_THRESHOLDS.FUEL_ALREADY_LOW_PCT) {
    // (a) plausible — no window ever needed, nothing anomalous to log.
    return { reading: { value: 0, trust: 'trusted', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs }, anomalies: [] }
  }
  // (b)/(c) collapsed: a stateless entry has no future readings to wait
  // on, so rule (c)'s "closes with no further readings -> resolves to
  // real, alerts" applies immediately (CM1: uncertainty fails toward
  // alerting, never suppression).
  const anomalies: AnomalyEntry[] = [
    { ruleId: 'fuel-suspect-resolved', truckId: ctx.truckId, rawValue: 0, readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs },
  ]
  return { reading: { value: 0, trust: 'trusted', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs }, anomalies }
}

function classifyFuelLive(valuePct: number, state: FuelState, ctx: ClassifyContext): ClassifyResult<number> {
  const anomalies: AnomalyEntry[] = []

  // Lazily resolve an already-open window if this reading's timestamp
  // shows the window has run out, *before* classifying the new value.
  if (state.window !== null && ctx.readingTs - state.window.openedAtReadingTs >= CLIENT_THRESHOLDS.FUEL_SUSPECT_WINDOW_MS) {
    anomalies.push(suspectResolvedAnomaly(ctx.truckId, state))
    state.lastTrustedPct = 0
    state.window = null
  }

  if (valuePct !== 0) {
    // A plausible reading recovers any window still open at this point
    // (i.e. one that hadn't yet timed out above) — the original 0% was a
    // false glitch, not a real depletion.
    if (state.window !== null) {
      anomalies.push(suspectResolvedAnomaly(ctx.truckId, state))
      state.window = null
    }
    state.lastTrustedPct = valuePct
    return { reading: { value: valuePct, trust: 'trusted', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs }, anomalies }
  }

  // valuePct === 0
  const baseline = state.lastTrustedPct
  if (baseline !== null && baseline <= CLIENT_THRESHOLDS.FUEL_ALREADY_LOW_PCT) {
    // (a) already low -> plausible, alert immediately, no window needed.
    state.lastTrustedPct = 0
    return { reading: { value: 0, trust: 'trusted', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs }, anomalies }
  }

  // (b) cliff-drop from a healthy level (or an unknown cold-start
  // baseline, which FR-5 treats as a pending FR-8(c) case) -> open (or
  // continue) a suspect window.
  if (state.window === null) {
    state.window = { openedAtReadingTs: ctx.readingTs, arrivalTsAtOpen: ctx.arrivalTs }
  }
  if (baseline === null) {
    // Nothing trusted to fall back to yet — FR-5's "no trusted reading
    // yet" persists while the window is pending.
    return { reading: null, anomalies }
  }
  return { reading: { value: baseline, trust: 'suspect', readingTs: ctx.readingTs, arrivalTs: ctx.arrivalTs }, anomalies }
}

/** Exported for direct unit testing (fuel.test.ts); the registry wraps
 * this same function for pipeline use. */
export function classifyFuel(valuePct: number, state: FuelState, ctx: ClassifyContext): ClassifyResult<number> {
  return ctx.mode === 'backfill' ? classifyFuelBackfill(valuePct, state, ctx) : classifyFuelLive(valuePct, state, ctx)
}

registerSignal<number, FuelState>({
  name: 'fuel',
  extractRawValue: (reading) => reading.fuel,
  createInitialState: () => ({ lastTrustedPct: null, window: null }),
  classify: classifyFuel,
})
