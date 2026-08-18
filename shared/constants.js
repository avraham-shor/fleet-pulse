// FleetPulse — Tunable Constants (AD-2)
//
// Every value here is authored, not observed: we write both the server that
// emits the stream and the client that classifies it, so both sides are
// fixed together in this one module. Imported by server.js, client code,
// and tests alike — a tunable literal anywhere else is a defect.
//
// Where the assignment brief fixes a value, the constant is the brief's;
// only free parameters are ours to choose. See
// _bmad-output/specs/spec-Fleet-Pulse/constants.md for the full rationale
// behind each value.

// --- Client thresholds -----------------------------------------------------

export const CLIENT_THRESHOLDS = Object.freeze({
  // Above this and below SENSOR_FAULT_CEILING_KMH = real overspeed → alert (CM1)
  OVERSPEED_ALERT_KMH: 120,

  // Physically impossible for a delivery truck; above this = sensor fault
  SENSOR_FAULT_CEILING_KMH: 200,

  // Below this, a 0% reading is plausible → alert immediately (CM1)
  FUEL_ALREADY_LOW_PCT: 10,

  // Documented glitch is 2-4s; margin included; fails toward alerting
  FUEL_SUSPECT_WINDOW_MS: 5_000,

  // Five missed 2-second update cycles
  STALENESS_BADGE_THRESHOLD_MS: 10_000,

  // No event from a dispatcher for this long → presence entry removed
  PRESENCE_LIVENESS_TIMEOUT_MS: 30_000,

  // ~10 min of history per signal, per truck (NFR-3); per-signal caps mean
  // a GPS burst never evicts fuel/temp history
  TELEMETRY_HISTORY_CAP_PER_SIGNAL: 300,

  // One batched commit covers all trucks; absorbs SSE floods (NFR-1)
  RENDER_COALESCE_MAX_COMMITS_PER_SEC: 10,

  // Recovery probing never violates server backpressure (FR-24, FR-25)
  BREAKER_PROBE_INTERVAL_MS: 10_000,

  // Reconnect backoff (SSE/WS): fast recovery without hammering the server (FR-27)
  RECONNECT_BACKOFF_INITIAL_MS: 1_000,
  RECONNECT_BACKOFF_MAX_MS: 15_000,

  // Unit-testable proxy for "no visible stall" (NFR-2)
  BATCH_PROCESSING_BUDGET_MS: 50,
  BATCH_PROCESSING_BUDGET_READING_COUNT: 30,

  // The degraded banner never flaps (CM2, FR-26)
  BANNER_CLEAR_HYSTERESIS_MS: 5_000,
})

// --- Server emission parameters --------------------------------------------
//
// The other half of the pair: what server.js emits, so each client
// threshold above has something real to classify.

export const SERVER_PARAMS = Object.freeze({
  TELEMETRY_TICK_MS: 2_000,

  GPS_BATCH_SIZE_MIN: 10,
  GPS_BATCH_SIZE_MAX: 30,

  FUEL_FALSE_ZERO_GLITCH_MIN_MS: 2_000,
  FUEL_FALSE_ZERO_GLITCH_MAX_MS: 4_000,

  // Stuck speed sensor: truck_7 held at 999 km/h for 5-10s
  STUCK_SPEED_TRUCK_ID: 'truck_7',
  STUCK_SPEED_KMH: 999,
  STUCK_SPEED_DURATION_MIN_MS: 5_000,
  STUCK_SPEED_DURATION_MAX_MS: 10_000,

  // Ghost disconnect: 20% chance, fixed 10s delay (the client still
  // tolerates up to 10s per FR-19)
  GHOST_DISCONNECT_CHANCE: 0.2,
  GHOST_DISCONNECT_DELAY_MS: 10_000,

  // Fleet GET fails intermittently under load, with Retry-After
  FLEET_503_CHANCE: 0.15,

  FLEET_SIZE: 12,
})
