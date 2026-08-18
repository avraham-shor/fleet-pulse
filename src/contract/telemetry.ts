// FleetPulse — wire contract: SSE telemetry envelope (AD-13)
//
// Declares exactly what `server.js` emits on `GET /api/telemetry/stream`.
// Field names are brief-verbatim where the brief names them (`truckId`,
// per the Consistency Conventions table and the brief's own `dispatcherId`
// example); where the brief is silent (the reading fields themselves), this
// file is authoritative (AD-13) — camelCase, matching that same convention.
//
// This story declares only what server.js emits. Client→server shapes and
// the transport layer are story 1.3's half of AD-13.

/**
 * One sensor snapshot for one truck, as emitted by the simulator.
 *
 * `timestamp` is the *reading* timestamp (when the simulated sensor took
 * the reading), epoch milliseconds — this is the wire's only timestamp
 * field; the reading-timestamp/arrival-clock split (trust-model.md) is an
 * internal client concept applied downstream of this boundary, not a wire
 * shape.
 */
export interface TelemetryReading {
  truckId: string
  timestamp: number
  lat: number
  lng: number
  /** km/h. May be 999 (stuck-speed quirk) or otherwise implausible — the
   * wire is faithful to the sensor, not to plausibility. */
  speed: number
  /** 0-100. May be a false 0% (fuel-glitch quirk). */
  fuel: number
  /** Celsius. */
  engineTemp: number
  /** Cumulative km, monotonically non-decreasing per truck. */
  mileage: number
}

/**
 * One SSE `data:` payload. Normally wraps exactly one reading; wraps
 * 10-30 when the GPS-batch quirk (#1) fires, so a batch and a normal tick
 * share one shape instead of two.
 */
export interface TelemetryBatch {
  truckId: string
  readings: TelemetryReading[]
}

/** The shape returned by `GET /api/telemetry/history/:truckId?limit=`. */
export type TelemetryHistoryResponse = TelemetryReading[]
