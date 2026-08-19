# FleetPulse — Test Matrix

The assignment mandates a minimum of eight meaningful tests over the hard parts. The six mandated areas alone account for fourteen cases; two self-imposed areas bring it to sixteen. **No "it renders" tests.**

| Test area | Requirement | Min cases | The cases |
|---|---|---|---|
| GPS batch processing | FR-3 | 1 | 30-reading batch → marker on newest-by-timestamp, one sorted trail, within the batch budget |
| Out-of-order timestamps | FR-6 | 2 | older reading never overwrites current state; backfill + equal-timestamp / in-batch edge |
| Fuel: real 0% vs. glitch | FR-8 | 4 | already-low → instant alert; cliff-drop → suspect window; persists past window → real alert; batch containing the recovery resolves with no wall-clock wait |
| Speed: 999 km/h + real overspeed | FR-7 | 2 | sensor-fault branch masked and logged; 120–200 km/h raises a real alert (CM1) |
| Optimistic locking / conflict flow | FR-12, FR-13 | 2 | stale-version 409; mid-processing race 409 through the same path |
| Ghost dispatcher presence | FR-19 | 3 | late/duplicate disconnect is a safe no-op; liveness timeout removes a silent ghost; a late disconnect never removes a re-registered dispatcher (new identity) |
| Circuit breaker *(self-imposed)* | FR-25 | 1 | 3×503 opens; probe honors max(interval, `Retry-After`); success closes |
| Busy-truck creation guard *(self-imposed)* | FR-34 | 1 | creating a route for a truck with an active one requires confirmation |
| Anomaly view rendering *(self-imposed)* | FR-29 | 2 | anomalies present → every entry shows truck id, rule/type, and timestamp, sourced only from `obs.anomalyLog`; no anomalies yet → explicit empty state, never blank |
| Developer metrics panel *(self-imposed)* | FR-30 | 2 | healthy transport → live SSE events/sec, WS ping/pong RTT, zero dropped/reconnect counts; dropped/reconnect activity → reflected on the next tick, no new fetch/subscription path |

**Twenty or more cases total.**

## Structural assertions

These are not in the mandated table but are the acceptance evidence named by their NFRs:

- **NFR-1** — count coalesced state-commits under a synthetic event flood; the ceiling holds.
- **NFR-2** — a 30-reading batch ingests within the batch-processing budget.
- **NFR-3** — every bounded collection's cap is asserted in a test (structural verification; the 8-hour claim follows from the caps, with a soak run noted in README as future work).
- **Contract fidelity** — one test asserts every `server.js` emission parses against the `contract/` type declarations.

## Conventions

- **Framework-free by default.** Pipeline, store, breaker, and presence cases run in the node environment against modules that import no React and no DOM — that is where the sixteen mandated cases live. Testing Library + jsdom appear only where behavior is genuinely UI-visible (the conflict chooser, the degraded banner), selected per file with a `// @vitest-environment jsdom` docblock.
- **Constants are imported, never re-hardcoded** — a test that copies a threshold has stopped testing the system (see [constants.md](constants.md)).
- **Test names cite their FR** — e.g. `FR-8c persists past window → alerts`. This is half of the G5 traceability claim; commits and `DECISIONS.md` entries are the other half.
- **Tests are written alongside the pipeline, not deferred** to a cleanup pass at the end.
