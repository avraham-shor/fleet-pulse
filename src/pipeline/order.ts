// FleetPulse — order/dedupe stage (AD-4, FR-6)
//
// Second pipeline filter: given one truck's batch of readings (already
// parsed by `ingest`), sorts them into reading-timestamp order and tags
// each as `live` (advances the truck's cursor — the newest-so-far state)
// or `backfill` (older than the cursor at the point it's reached — never
// overwrites live state, still classified downstream in stateless mode).
//
// Mirrors server.js's own `recordReading` — "newest reading timestamp
// wins" — but walks the sorted batch one reading at a time (not a single
// batch-max shortcut) so a fuel suspect window opened by an early reading
// in the same batch can still resolve against a later, in-batch recovery
// reading with no artificial wait (FR-8, "recovery inside one batch").

import type { TelemetryReading } from '../contract/telemetry.ts'
import type { IngestMode } from './types.ts'

/** One truck's live-state cursor: the reading timestamp of the newest
 * reading applied to live state so far. `null` before any reading has ever
 * been applied (cold start / post-reset). */
export interface TruckCursor {
  cursorReadingTs: number | null
}

export function createTruckCursor(): TruckCursor {
  return { cursorReadingTs: null }
}

export interface OrderedReading {
  reading: TelemetryReading
  mode: IngestMode
}

/**
 * Sorts `readings` ascending by `timestamp` (stable — ties keep their
 * original relative order) and classifies each as `live` or `backfill`
 * against `cursor`, mutating `cursor` forward as `live` readings are
 * walked. A reading whose timestamp ties the cursor counts as `live` —
 * matching server.js's own `>=` "newest wins" comparison (recordReading).
 */
export function orderReadings(readings: readonly TelemetryReading[], cursor: TruckCursor): OrderedReading[] {
  const sorted = [...readings].sort((a, b) => a.timestamp - b.timestamp)
  const ordered: OrderedReading[] = []
  let working = cursor.cursorReadingTs

  for (const reading of sorted) {
    if (working === null || reading.timestamp >= working) {
      ordered.push({ reading, mode: 'live' })
      working = reading.timestamp
    } else {
      ordered.push({ reading, mode: 'backfill' })
    }
  }

  cursor.cursorReadingTs = working
  return ordered
}
