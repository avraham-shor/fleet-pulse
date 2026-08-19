import { describe, expect, it } from 'vitest'
import { CLIENT_THRESHOLDS, SERVER_PARAMS } from './constants.js'

// Explicit expected key sets, so a deleted or renamed constant fails loudly
// instead of a shape test silently iterating over fewer entries.
const EXPECTED_CLIENT_THRESHOLDS_KEYS = [
  'OVERSPEED_ALERT_KMH',
  'SENSOR_FAULT_CEILING_KMH',
  'FUEL_ALREADY_LOW_PCT',
  'FUEL_SUSPECT_WINDOW_MS',
  'STALENESS_BADGE_THRESHOLD_MS',
  'PRESENCE_LIVENESS_TIMEOUT_MS',
  'TELEMETRY_HISTORY_CAP_PER_SIGNAL',
  'ANOMALY_LOG_CAP',
  'AUDIT_TRAIL_CAP',
  'RENDER_COALESCE_MAX_COMMITS_PER_SEC',
  'BREAKER_PROBE_INTERVAL_MS',
  'RECONNECT_BACKOFF_INITIAL_MS',
  'RECONNECT_BACKOFF_MAX_MS',
  'BATCH_PROCESSING_BUDGET_MS',
  'BATCH_PROCESSING_BUDGET_READING_COUNT',
  'BANNER_CLEAR_HYSTERESIS_MS',
  'WS_KEEPALIVE_PING_MS',
  'STALENESS_TICK_MS',
  'RECONNECT_BACKOFF_MULTIPLIER',
  'BREAKER_FAILURE_THRESHOLD',
]

const EXPECTED_SERVER_PARAMS_KEYS = [
  'SERVER_PORT',
  'TELEMETRY_TICK_MS',
  'GPS_BATCH_SIZE_MIN',
  'GPS_BATCH_SIZE_MAX',
  'FUEL_FALSE_ZERO_GLITCH_MIN_MS',
  'FUEL_FALSE_ZERO_GLITCH_MAX_MS',
  'STUCK_SPEED_TRUCK_ID',
  'STUCK_SPEED_KMH',
  'STUCK_SPEED_DURATION_MIN_MS',
  'STUCK_SPEED_DURATION_MAX_MS',
  'GHOST_DISCONNECT_CHANCE',
  'GHOST_DISCONNECT_DELAY_MS',
  'FLEET_503_CHANCE',
  'FLEET_503_RETRY_AFTER_S',
  'FLEET_SIZE',
  'OUT_OF_ORDER_CHANCE',
  'OUT_OF_ORDER_MAX_SKEW_MS',
  'GPS_BATCH_CHANCE',
  'FUEL_GLITCH_CHANCE',
  'STUCK_SPEED_CHANCE',
  'SYSTEM_REASSIGN_CHANCE',
  'ROUTE_MUTATION_PROCESSING_DELAY_MS',
  'TELEMETRY_HISTORY_CAP',
]

// Fields whose value is a name/id, not a magnitude — excluded from the
// numeric-shape and positivity checks below.
const NON_NUMERIC_KEYS = new Set(['STUCK_SPEED_TRUCK_ID'])

// Fields that are probability fractions, not magnitudes — checked for the
// 0..1 range instead of plain positivity.
const CHANCE_KEYS = new Set([
  'GHOST_DISCONNECT_CHANCE',
  'FLEET_503_CHANCE',
  'OUT_OF_ORDER_CHANCE',
  'GPS_BATCH_CHANCE',
  'FUEL_GLITCH_CHANCE',
  'STUCK_SPEED_CHANCE',
  'SYSTEM_REASSIGN_CHANCE',
])

describe('shared/constants', () => {
  it('freezes both exports so accidental mutation throws, not silently succeeds (AD-2)', () => {
    expect(Object.isFrozen(CLIENT_THRESHOLDS)).toBe(true)
    expect(Object.isFrozen(SERVER_PARAMS)).toBe(true)
  })

  it('exports exactly the expected key set per group, catching deletions and renames', () => {
    expect(Object.keys(CLIENT_THRESHOLDS).sort()).toEqual([...EXPECTED_CLIENT_THRESHOLDS_KEYS].sort())
    expect(Object.keys(SERVER_PARAMS).sort()).toEqual([...EXPECTED_SERVER_PARAMS_KEYS].sort())
  })

  it('exports every tunable as a finite number, except named/id fields', () => {
    for (const [group, values] of Object.entries({ CLIENT_THRESHOLDS, SERVER_PARAMS })) {
      for (const [key, value] of Object.entries(values)) {
        if (NON_NUMERIC_KEYS.has(key)) continue
        expect(Number.isFinite(value), `${group}.${key} should be a finite number`).toBe(true)
      }
    }
  })

  it('keeps every magnitude constant strictly positive', () => {
    for (const [group, values] of Object.entries({ CLIENT_THRESHOLDS, SERVER_PARAMS })) {
      for (const [key, value] of Object.entries(values)) {
        if (NON_NUMERIC_KEYS.has(key) || CHANCE_KEYS.has(key)) continue
        expect(value, `${group}.${key} should be > 0`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps every probability constant inside the 0..1 range', () => {
    for (const [key, value] of Object.entries(SERVER_PARAMS)) {
      if (!CHANCE_KEYS.has(key)) continue
      expect(value, `SERVER_PARAMS.${key} should be >= 0`).toBeGreaterThanOrEqual(0)
      expect(value, `SERVER_PARAMS.${key} should be <= 1`).toBeLessThanOrEqual(1)
    }
  })

  it('names the stuck-speed truck inside the fleet (server quirk targets a real truck)', () => {
    expect(SERVER_PARAMS.STUCK_SPEED_TRUCK_ID).toMatch(/^truck_\d+$/)
    const index = Number(SERVER_PARAMS.STUCK_SPEED_TRUCK_ID.split('_')[1])
    expect(index).toBeGreaterThanOrEqual(1)
    expect(index).toBeLessThanOrEqual(SERVER_PARAMS.FLEET_SIZE)
  })

  it('pairs the overspeed alert threshold below the sensor-fault ceiling (CM1)', () => {
    expect(CLIENT_THRESHOLDS.OVERSPEED_ALERT_KMH).toBeLessThan(
      CLIENT_THRESHOLDS.SENSOR_FAULT_CEILING_KMH,
    )
  })

  it('pairs the stuck-speed sensor value above the sensor-fault ceiling it must trip', () => {
    expect(SERVER_PARAMS.STUCK_SPEED_KMH).toBeGreaterThan(CLIENT_THRESHOLDS.SENSOR_FAULT_CEILING_KMH)
  })

  it('keeps the GPS batch size range non-inverted', () => {
    expect(SERVER_PARAMS.GPS_BATCH_SIZE_MIN).toBeLessThanOrEqual(SERVER_PARAMS.GPS_BATCH_SIZE_MAX)
  })

  it('keeps the fuel false-zero glitch window non-inverted', () => {
    expect(SERVER_PARAMS.FUEL_FALSE_ZERO_GLITCH_MIN_MS).toBeLessThanOrEqual(
      SERVER_PARAMS.FUEL_FALSE_ZERO_GLITCH_MAX_MS,
    )
  })

  it('keeps the stuck-speed duration range non-inverted', () => {
    expect(SERVER_PARAMS.STUCK_SPEED_DURATION_MIN_MS).toBeLessThanOrEqual(
      SERVER_PARAMS.STUCK_SPEED_DURATION_MAX_MS,
    )
  })

  it('keeps reconnect backoff bounds non-inverted (FR-27)', () => {
    expect(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS).toBeLessThanOrEqual(
      CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS,
    )
  })

  it('keeps the fuel suspect window above the server glitch it must outlast (CM1)', () => {
    // The glitch is documented as 2-4s; the suspect window must stay above
    // the glitch's max, or every simulated glitch alerts as a real fault.
    expect(CLIENT_THRESHOLDS.FUEL_SUSPECT_WINDOW_MS).toBeGreaterThan(
      SERVER_PARAMS.FUEL_FALSE_ZERO_GLITCH_MAX_MS,
    )
  })

  it('pins the staleness badge threshold to five missed telemetry ticks, per its own rationale', () => {
    expect(CLIENT_THRESHOLDS.STALENESS_BADGE_THRESHOLD_MS).toBe(5 * SERVER_PARAMS.TELEMETRY_TICK_MS)
  })

  it('keeps presence liveness above the server ghost-disconnect delay it must tolerate (FR-19)', () => {
    expect(CLIENT_THRESHOLDS.PRESENCE_LIVENESS_TIMEOUT_MS).toBeGreaterThan(
      SERVER_PARAMS.GHOST_DISCONNECT_DELAY_MS,
    )
  })

  it('keeps the batch-processing budget under one coalesced commit window (NFR-1, NFR-2)', () => {
    const commitWindowMs = 1000 / CLIENT_THRESHOLDS.RENDER_COALESCE_MAX_COMMITS_PER_SEC
    expect(CLIENT_THRESHOLDS.BATCH_PROCESSING_BUDGET_MS).toBeLessThan(commitWindowMs)
  })

  it('keeps the route-mutation processing delay imperceptible against the telemetry tick (story 1.2)', () => {
    // The artificial PATCH-race window must stay well under one telemetry
    // tick, or route mutations would visibly lag the live stream.
    expect(SERVER_PARAMS.ROUTE_MUTATION_PROCESSING_DELAY_MS).toBeLessThan(SERVER_PARAMS.TELEMETRY_TICK_MS)
  })

  it('keeps the server telemetry history cap the same order of magnitude as the client per-signal cap', () => {
    expect(SERVER_PARAMS.TELEMETRY_HISTORY_CAP).toBe(CLIENT_THRESHOLDS.TELEMETRY_HISTORY_CAP_PER_SIGNAL)
  })

  it('sizes the anomaly log cap to match its sibling telemetry-history cap (story 4 design notes, AD-18)', () => {
    expect(CLIENT_THRESHOLDS.ANOMALY_LOG_CAP).toBe(CLIENT_THRESHOLDS.TELEMETRY_HISTORY_CAP_PER_SIGNAL)
  })

  it('sizes the audit trail cap to match its sibling caps (story 7 design notes, AD-10)', () => {
    expect(CLIENT_THRESHOLDS.AUDIT_TRAIL_CAP).toBe(CLIENT_THRESHOLDS.TELEMETRY_HISTORY_CAP_PER_SIGNAL)
  })
})
