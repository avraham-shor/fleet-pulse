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
| WS keepalive ping interval | 15 s | AD-8: the WS manager sends `ping` at this interval and consumes `pong` (ping/pong RTT feeds FR-30's latency metric); half of the 30 s presence liveness timeout so one missed pong doesn't itself retire an entry |
| Staleness re-evaluation tick | 1 s | AD-3: the one constants-defined tick, started by `app/`, that re-evaluates the effective-trust selector — an order of magnitude under the 10 s staleness badge threshold so the badge flips promptly |
| Reconnect backoff multiplier | 2× | The "doubling" half of the 1 s → 15 s backoff curve (FR-27) |
| Circuit breaker failure threshold | 3 consecutive 503s | AD-8, FR-25: each completed attempt counts, retries included; opens the circuit into degraded mode on cached data |

## Server emission parameters

The other half of the pair: what `server.js` emits, so each client threshold has something real to classify.

| Parameter | Value |
|---|---|
| Telemetry tick | 2 s |
| GPS batch size | 10–30 buffered readings |
| Fuel false-0% glitch window | 2–4 s |
| Stuck speed sensor | `truck_7`, 999 km/h, held 5–10 s |
| Ghost disconnect | 20% chance, fixed 10 s delay (the client's 30 s presence liveness timeout already tolerates this; FR-19) |
| Fleet 503 under load | 15% chance, `Retry-After: 3` s |
| Fleet size | 12 trucks |
| Out-of-order SSE (quirk #5) | 10% chance, timestamp skewed back up to 3 s |
| GPS batch trigger (quirk #1) | 5% chance per truck per tick |
| Fuel glitch trigger (quirk #2) | 5% chance per truck per tick |
| Stuck speed trigger (quirk #3) | 5% chance per tick (`truck_7` only) |
| System-dispatcher reassign (quirks #4, #8) | 5% chance per tick |
| Route-mutation processing delay | 150 ms, on `PATCH`/`PUT reassign` |
| Server telemetry history cap | 300 readings per truck |

**Free parameters** — start positions, in-range batch and cadence distributions — are build-time choices made inside the same module, not scattered across the simulator.

**Story 1.2 additions and rationale.** The brief fixes no probability for quirk #5 (out-of-order); chosen low (10%) with a shallow skew (~3 s, a couple of ticks) — old enough to exercise FR-6 backfill, not so old it desyncs the trail. The same `OUT_OF_ORDER_CHANCE` roll also decides whether a generated GPS batch (quirk #1) contains one adjacent non-monotonic swap, since both are timestamp-ordering concerns and one constant covers both rather than adding a second. Quirks #1–#3 are documented with a size/duration range each but no trigger frequency — without one they could never self-fire unattended, so each gets its own 5%-per-tick trigger chance, the same order of magnitude as the brief-fixed per-request chances above. Quirks #4 (stale-version 409) and #8 (PATCH race) aren't self-timed by the brief either; both are consequences of *something* changing a route out from under a stale reader, and the one autonomous actor that can do that unattended is quirk 8's synthetic "system" dispatcher (AD-12). `SYSTEM_REASSIGN_CHANCE` (5% per tick) is that one mechanism: a small per-tick chance the system dispatcher reassigns an active/in-progress route to a different truck. That single knob is what makes both quirks self-fire — #4 whenever anyone later holds the now-stale version, #8 specifically when the reassignment lands mid-PATCH.

`ROUTE_MUTATION_PROCESSING_DELAY_MS` (150 ms) is a second, distinct piece of quirk #8's mechanism: without *some* gap between reading a route's version and committing a write, no request could ever be raced against — Node's single-threaded event loop would run a synchronous handler to completion before anything else touches the route. The delay is deliberately far under one telemetry tick (2 s) so it's imperceptible in the UI, but long enough that the system dispatcher's chaos reassignment (or a genuinely concurrent second request) reliably lands inside it, both unattended and on demand via `/api/dev/quirk/8`. `TELEMETRY_HISTORY_CAP` (300) bounds the server's own per-truck telemetry history buffer feeding `GET /api/telemetry/history/:truckId` (NFR-3) — deliberately the same value as the client's `TELEMETRY_HISTORY_CAP_PER_SIGNAL`, though it caps a different, simpler collection (one arrival-ordered buffer of full readings per truck, not the client's per-signal, timestamp-sorted store).

## Pairing rule

A client threshold and the server parameter it classifies are chosen **together**, in one file, before any test freezes either. Changing one side without the other is how a test suite ends up asserting behavior the running system no longer has.
