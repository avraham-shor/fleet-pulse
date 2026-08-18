# FleetPulse — Tunable Constants

Every value below is authored, not observed — we write the server that emits the stream *and* the client that classifies it, so both sides are fixed together from one source. All of them live in exactly one module, `shared/constants.js`, imported by `server.js`, client code, and tests alike (AD-2). **A tunable literal anywhere else is a defect.** Where the assignment brief fixes a value, the constant is the brief's; only free parameters are ours to choose.

## Client thresholds

| Constant | Default | Rationale |
|---|---|---|
| Overspeed alert limit | 120 km/h | Above this and below the ceiling = real overspeed → immediate dispatcher alert (CM1) |
| Sensor-fault ceiling | 200 km/h | Physically impossible for a delivery truck; above this = sensor fault, value masked and logged |
| Fuel "already low" threshold | 10% | Below this, a 0% reading is plausible → alert immediately (CM1) |
| Fuel suspect/debounce window | 5 s | Documented glitch is 2–4 s; margin included; fails toward alerting |
| Staleness badge threshold | 10 s | Five missed 2-second update cycles |
| Presence liveness timeout | 30 s | No event from a dispatcher for this long → entry removed; covers never-arriving disconnects and reconnect duplicates |
| Telemetry history per truck | ~300 readings (≈10 min) **per signal** | Bounds charts and trails (NFR-3); per-signal caps mean a GPS burst never evicts fuel/temp history |
| Render coalescing ceiling | ≤10 state-commits/sec, global | One batched commit covers all trucks; above human-perceptible need; absorbs SSE floods (NFR-1) |
| Breaker probe interval | 10 s, or last `Retry-After` if longer | Recovery probing never violates server backpressure (FR-24, FR-25) |
| Reconnect backoff (SSE/WS) | 1 s doubling to a 15 s cap | Fast recovery without hammering a struggling server (FR-27) |
| Batch-processing budget | 50 ms per 30-reading batch | Unit-testable proxy for "no visible stall" (NFR-2) |
| Banner clear hysteresis | 5 s healthy | The degraded banner never flaps (CM2, FR-26) |

## Server emission parameters

The other half of the pair: what `server.js` emits, so each client threshold has something real to classify.

| Parameter | Value |
|---|---|
| Telemetry tick | 2 s |
| GPS batch size | 10–30 buffered readings |
| Fuel false-0% glitch window | 2–4 s |
| Stuck speed sensor | `truck_7`, 999 km/h, held 5–10 s |
| Ghost disconnect | 20% chance, fixed 10 s delay (the client still tolerates *up to* 10 s per FR-19) |
| Fleet 503 under load | 15% chance, with `Retry-After` |
| Fleet size | 12 trucks |

**Free parameters** — start positions, in-range batch and cadence distributions — are build-time choices made inside the same module, not scattered across the simulator.

## Pairing rule

A client threshold and the server parameter it classifies are chosen **together**, in one file, before any test freezes either. Changing one side without the other is how a test suite ends up asserting behavior the running system no longer has.
