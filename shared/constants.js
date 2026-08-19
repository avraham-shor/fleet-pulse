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
//
// Units convention: `_MS` = milliseconds, `_KMH` = km/h, `_PCT` = percentage
// points (0-100), `_CHANCE` = a probability fraction (0-1), `_S` = seconds
// (used only for values that cross the wire as HTTP header seconds, e.g.
// `Retry-After`).

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

  // AD-18: cap on the obs slice's anomaly log boundedBuffer. No existing
  // constant covered this (story 4 design notes) — set equal to
  // TELEMETRY_HISTORY_CAP_PER_SIGNAL as a free parameter (AD-2) sized to
  // match its sibling cap rather than inventing an unrelated number; the
  // two are editable independently later.
  ANOMALY_LOG_CAP: 300,

  // AD-10/NFR-3: cap on routesSlice's session-scoped audit trail
  // (createBoundedBuffer, mirroring ANOMALY_LOG_CAP's own pattern). No
  // existing constant covered this either (story 7 design notes) — sized
  // to match its sibling caps rather than inventing an unrelated number.
  AUDIT_TRAIL_CAP: 300,

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

  // AD-8: WS manager sends `ping` at this interval, consumes `pong`
  // (ping/pong RTT is FR-30's latency metric). Half of the presence
  // liveness timeout so one missed pong doesn't itself retire an entry.
  WS_KEEPALIVE_PING_MS: 15_000,

  // AD-3: the one constants-defined tick, started by app/, that
  // re-evaluates the effective-trust selector. An order of magnitude
  // under the staleness badge threshold so the badge flips promptly.
  STALENESS_TICK_MS: 1_000,

  // The "doubling" half of the reconnect backoff curve (FR-27)
  RECONNECT_BACKOFF_MULTIPLIER: 2,

  // Three consecutive failed 503s open the circuit (AD-8, FR-25);
  // each completed attempt counts, retries included
  BREAKER_FAILURE_THRESHOLD: 3,
})

// --- Server emission parameters --------------------------------------------
//
// The other half of the pair: what server.js emits, so each client
// threshold above has something real to classify.

export const SERVER_PARAMS = Object.freeze({
  // The one place the port lives; vite.config.ts's dev proxy imports this
  // rather than hardcoding it a second time
  SERVER_PORT: 3_000,

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
  FLEET_503_RETRY_AFTER_S: 3,

  FLEET_SIZE: 12,

  // Out-of-order SSE (quirk #5): the brief fixes no probability, only that
  // it happens sometimes. Free parameter (AD-2, story 1.2 design notes):
  // low chance, skew a few ticks deep — old enough to exercise FR-6
  // backfill, not so old it desyncs the trail. Reused for the GPS-batch
  // quirk's own occasional non-monotonic entry (both are "timestamp
  // ordering" concerns; one constant, not two).
  OUT_OF_ORDER_CHANCE: 0.1,
  OUT_OF_ORDER_MAX_SKEW_MS: 3_000,

  // Quirks 1/2/3 (GPS batch, fuel glitch, stuck speed) are documented with
  // a size/duration range each but not a trigger frequency — without one
  // they could never self-fire "unattended" (story 1.2 AC). Free
  // parameters, same order of magnitude as the brief-fixed per-request
  // chances above; rolled once per truck per telemetry tick.
  GPS_BATCH_CHANCE: 0.05,
  FUEL_GLITCH_CHANCE: 0.05,
  STUCK_SPEED_CHANCE: 0.05,

  // Quirks 4 (stale-version 409) and 8 (PATCH race) aren't self-timed in
  // the brief either — they're consequences of *something* changing a
  // route out from under a stale reader. The one autonomous actor that can
  // cause that unattended is quirk 8's own synthetic "system" dispatcher
  // (AD-12): per tick, a small chance it reassigns one active/in-progress
  // route to a different truck. That single mechanism is what makes both
  // quirks self-fire — #4 whenever anyone is later holding the
  // now-stale version, #8 when the reassignment lands mid-PATCH.
  SYSTEM_REASSIGN_CHANCE: 0.05,

  // Artificial processing delay on version-checked route mutations (PATCH,
  // PUT reassign) between reading the client's `If-Match` and committing
  // the write. Gives quirk #8 (and any two genuinely concurrent requests) a
  // real window to land mid-request instead of only ever racing at entry.
  // Small enough to be imperceptible in the UI; large enough that the dev
  // quirk trigger (or the self-firing scheduler) reliably lands inside it.
  ROUTE_MUTATION_PROCESSING_DELAY_MS: 150,

  // Cap on the server's own in-memory telemetry history buffer per truck,
  // feeding GET /api/telemetry/history/:truckId. This is arrival-ordered
  // raw wire history (NFR-3-bounded, server-side), a different, simpler
  // collection than the client's per-signal, timestamp-sorted store
  // (AD-10 governs that one) — same order of magnitude as the client's
  // TELEMETRY_HISTORY_CAP_PER_SIGNAL by design, not by coincidence.
  TELEMETRY_HISTORY_CAP: 300,
})
