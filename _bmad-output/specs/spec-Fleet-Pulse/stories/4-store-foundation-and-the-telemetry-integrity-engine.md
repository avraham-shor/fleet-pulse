---
title: 'Store foundation and the telemetry integrity engine'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: '63ab233899821865d5c953f7d38b35deea4aa451'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/trust-model.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/constants.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The transport layer delivers raw telemetry batches, but nothing yet turns noisy, out-of-order, occasionally-faked sensor data into values a dispatcher can trust — there is no ordering, no classification, no bounded history, and no single store to render from.

**Approach:** Build `pipeline/` (ingest → order/dedupe by reading timestamp → classify → one batched commit, AD-4) implementing FR-6/7/8's ordering and trust rules via a signal/anomaly-rule registry (AD-6), and `store/` (single Zustand store, `boundedBuffer` utility, coalescing commit, one effective-trust selector, anomaly log) that pipeline output lands in.

## Boundaries & Constraints

**Always:**
- `pipeline/` imports only `contract/` and `shared/constants.js` (AD-1) — no store import, no React, no DOM. It exposes one factory, `createPipeline({onCommit, onAnomaly})`, with `ingest(batch)`, `ingestBackfill(readings)`, `reset()` — the seams `app/` wires to live `sse-manager.onBatch` and the history endpoint in a later story; this story proves the seam via direct injection in its own tests.
- Fixed stage order per truck (AD-4): ingest (parse) → order/dedupe by `readingTs` (older-than-current backfills bounded history, never overwrites live state — FR-6) → classify (registry) → one batched commit. Backfills skip window bookkeeping but still pass classification (stateless plausibility only), so every history entry carries real trust.
- Trust is assigned only in the pipeline (AD-3), one `Reading<T>` envelope per signal — `{value, trust, readingTs, arrivalTs}` — trust ∈ {trusted, suspect, sensor-fault}. Speed classifies per FR-7 (`OVERSPEED_ALERT_KMH`/`SENSOR_FAULT_CEILING_KMH`); fuel 0% classifies per FR-8's hybrid policy (`FUEL_ALREADY_LOW_PCT`, `FUEL_SUSPECT_WINDOW_MS`, measured in reading timestamps per trust-model.md's two-clock rule, never wall-clock). Position/temperature/mileage pass through always-trusted (no plausibility rule yet). Uncertainty fails toward alerting, never suppression (CM1).
- One `boundedBuffer` utility (AD-10) backs every collection: per-truck per-signal history (`TELEMETRY_HISTORY_CAP_PER_SIGNAL`), the anomaly log (new `ANOMALY_LOG_CAP` constant — none exists yet; add it to `shared/constants.js` next to `TELEMETRY_HISTORY_CAP_PER_SIGNAL`, same value, both editable independently later).
- One Zustand store (AD-5): all pipeline output lands through one coalescing batched commit, ceiling `RENDER_COALESCE_MAX_COMMITS_PER_SEC`. Slices this story owns: telemetry (per-truck per-signal envelopes + bounded history) and obs (anomaly log + transport counters passthrough). A minimal `health` slice scaffold (`isDegraded: false`, `reason: null`) is created for the effective-trust selector to read — populating it from real circuit-breaker/connection signals is story 1.9's job, not this one.
- One effective-trust selector (AD-3) layers staleness (arrival clock vs `STALENESS_BADGE_THRESHOLD_MS`, re-evaluated on `STALENESS_TICK_MS` — the tick itself is started by `app/` later; this story exports the tick-driven recompute function) and `health.isDegraded` on top of the pipeline's per-signal trust, producing the five-state result (trusted/suspect/sensor-fault/stale/degraded) trust-model.md defines.
- Registration extensibility (AD-6): a new signal or anomaly rule is one module + one `register()` call into `pipeline/signals/registry.ts`; never edit an existing classifier to add another.
- Every anomaly (rejected/suspect-resolved value) emits one `{ruleId, truckId, rawValue, readingTs, arrivalTs}` entry to the obs slice's anomaly log via the batched commit (AD-18) — raw values never reach a widget outside that log.
- Tests run framework-free in the node environment, constants imported from `shared/constants.js` never re-hardcoded, names cite the FR (e.g. `FR-8c persists past window → alerts`) — matching the existing transport test convention (Vitest, fake timers, injected fakes).

**Ask First:** None anticipated — thresholds and window rules are fixed by trust-model.md/FR-7/FR-8. If a classification edge case genuinely isn't resolvable from those sources, HALT and confirm before encoding it.

**Never:** Build `app/` or wire pipeline/store into `main.tsx`/`App.tsx` (a later story's composition root); build the `fleet`, `routes`, or `presence` slices (stories 5/7/6 own them) or populate `health` from real signals (story 1.9); add a map/chart library; call `fetch` or open a socket from `pipeline/` or `store/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Out-of-order single reading | Reading older than truck's current `readingTs` | Discarded from live state, inserted into sorted bounded history at its timestamp position, still classified | Never overwrites newer state |
| GPS batch, 30 readings | One `TelemetryBatch` with non-monotonic interior + newest-last | Ordered by `readingTs`, newest applied to live state, full batch enters history within `BATCH_PROCESSING_BUDGET_MS` | Batch never partially applied |
| Speed sensor fault | `speed = 999` (> `SENSOR_FAULT_CEILING_KMH`) | `sensor-fault`; last plausible speed retained live; raw logged to anomaly log | Recovery clears the fault on next plausible reading |
| Speed real overspeed | `120 < speed ≤ 200` | `trusted`; alert-worthy from the first reading (CM1) | None — never suppressed |
| Fuel already-low → 0% | Prior trusted ≤ `FUEL_ALREADY_LOW_PCT`, then 0% | `trusted`, alerts immediately (FR-8a) | None |
| Fuel cliff-drop → 0% | Prior trusted healthy, then 0% | `suspect` with "validating" window opened | Window measured in `readingTs`, not arrival |
| Fuel 0% persists past window | No recovery reading within `FUEL_SUSPECT_WINDOW_MS` of reading time | Resolves to `trusted` (real), alerts (FR-8c) | Also resolves if window closes with zero further readings |
| Fuel recovery inside one batch | Batch readings span the whole suspect window incl. recovery | Resolves immediately, no artificial wait | No wall-clock timers used for this path |
| Stale 0% reopening window | 0% reading older than current trusted state | Discarded by ordering before classification; never reopens a window | FR-6 runs before FR-8 |
| Coalescing flood | 12 trucks × 2s ticks, synthetic burst | Commits per second stay ≤ `RENDER_COALESCE_MAX_COMMITS_PER_SEC` | Coalesced, not dropped |
| Collection at cap | History or anomaly log at its cap, new entry arrives | Oldest (by ordering key) evicted, cap never exceeded | Applies to every `boundedBuffer` instance |

</frozen-after-approval>

## Code Map

- `shared/constants.js:41` (`TELEMETRY_HISTORY_CAP_PER_SIGNAL`) -- add sibling `ANOMALY_LOG_CAP` (AD-18 gap: no cap constant exists yet for the anomaly log)
- `src/contract/telemetry.ts:21-45` -- `TelemetryReading`/`TelemetryBatch` shapes this pipeline ingests
- `src/transport/sse-manager.ts:33` (`onBatch: (batch: TelemetryBatch) => void`) -- the live seam a later story wires to `pipeline.ingest`; not called from here
- `server.js:483-515` (`recordReading`) -- server's own "newest reading wins" rule; client ordering (FR-6) mirrors this
- `server.js:339-389` (`buildBatchEmission`) -- shape of the non-monotonic GPS-batch edge case tests must cover
- `ARCHITECTURE-SPINE.md` AD-1, AD-3, AD-4, AD-5, AD-6, AD-10, AD-15, AD-18 -- binding rules this file must satisfy exactly
- `trust-model.md` -- five trust states, two-clock rule, FR-7/FR-8 precise thresholds and window semantics
- `src/pipeline/types.ts` (new) -- `Reading<T>` envelope, trust-state union
- `src/pipeline/order.ts` (new) -- per-truck cursor, order/dedupe by `readingTs`, backfill detection -- AD-4/FR-6
- `src/pipeline/signals/registry.ts` (new) -- signal/anomaly-rule registration (AD-6)
- `src/pipeline/signals/speed.ts` (new) -- FR-7 classifier
- `src/pipeline/signals/fuel.ts` (new) -- FR-8 hybrid classifier + suspect-window state
- `src/pipeline/signals/passthrough.ts` (new) -- always-trusted signals (position, temperature, mileage)
- `src/pipeline/index.ts` (new) -- `createPipeline({onCommit, onAnomaly})` public factory -- AD-1
- `src/store/boundedBuffer.ts` (new) -- generic capped buffer, optional ordering key -- AD-10
- `src/store/slices/telemetrySlice.ts` (new) -- per-truck per-signal envelopes + bounded history -- AD-15
- `src/store/slices/obsSlice.ts` (new) -- anomaly log + transport counter passthrough -- AD-18
- `src/store/slices/healthSlice.ts` (new) -- minimal `isDegraded`/`reason` scaffold only
- `src/store/selectors/effectiveTrust.ts` (new) -- layers stale + degraded over pipeline trust -- AD-3
- `src/store/store.ts` (new) -- single `create()`, coalescing commit scheduler -- AD-5
- `src/transport/ws-manager.test.ts` -- existing convention reference (Vitest, node env, injected fakes, fake timers)

## Tasks & Acceptance

**Execution:**
- [x] `shared/constants.js` -- add `ANOMALY_LOG_CAP` next to `TELEMETRY_HISTORY_CAP_PER_SIGNAL` -- AD-18
- [x] `src/pipeline/types.ts` -- `Reading<T>` envelope + trust union -- AD-3
- [x] `src/pipeline/order.ts` -- order/dedupe/backfill logic -- AD-4/FR-6
- [x] `src/pipeline/signals/{registry,speed,fuel,passthrough}.ts` -- classifiers + registration -- AD-6/FR-7/FR-8
- [x] `src/pipeline/index.ts` -- `createPipeline` factory: `ingest`/`ingestBackfill`/`reset` -- AD-1/AD-4
- [x] `src/store/boundedBuffer.ts` -- capped buffer utility -- AD-10
- [x] `src/store/slices/{telemetrySlice,obsSlice,healthSlice}.ts` -- store slices -- AD-15/AD-18
- [x] `src/store/selectors/effectiveTrust.ts` -- five-state selector -- AD-3
- [x] `src/store/store.ts` -- single store + coalescing commit -- AD-5
- [x] Co-located `*.test.ts` for pipeline order/classify (speed, fuel, batch), `boundedBuffer` cap eviction, coalescing ceiling, effective-trust staleness -- the 9 mandated FR-6/7/8 cases + NFR-1/2/3 structural assertions

**Acceptance Criteria:**
- Given a reading older than the truck's current state, when it's ingested, then live state is untouched and the reading lands in sorted bounded history, still classified.
- Given a 30-reading GPS batch with non-monotonic interior order, when ingested, then it commits within `BATCH_PROCESSING_BUDGET_MS` and history reflects timestamp order.
- Given `speed = 999`, when classified, then trust is `sensor-fault`, the last plausible speed stays live, and the raw value is in the anomaly log.
- Given fuel drops to 0% from a healthy trusted level, when the suspect window's time elapses and any subsequent reading for that truck arrives (any signal — resolution is lazy, checked on the next live classify call), then trust resolves to `trusted` and an alert fires. See Design Notes for the true-silence edge case.
- Given a batch whose readings span the entire fuel suspect window including recovery, when classified, then resolution happens immediately with no artificial wait.
- Given a synthetic flood of 12 trucks × 2s ticks, when run through the store, then committed-state count stays within `RENDER_COALESCE_MAX_COMMITS_PER_SEC`.
- Given any `boundedBuffer` at its cap, when one more entry is inserted, then the oldest-by-ordering-key entry is evicted and the cap holds.
- Given `npm test`, when it runs, then all new pipeline/store tests pass alongside the existing suite.

## Design Notes

**Pipeline↔store wiring stays test-only this story, not production-wired:** AD-1 assigns the commit-sink/reset/backfill injection to `app/`, which doesn't exist as its own story — `app/` composition (wiring live `sse-manager.onBatch` → `pipeline.ingest` → `store`) lands when the first UI story (1.5) needs real data on screen. This story proves the seam correct via direct injection in its own tests, mirroring story 1.3's "handler injection, not direct import" resolution for the same not-yet-built-consumer problem.

**Signal registry doubles as the anomaly-rule registry:** the spine names these as two registries (AD-6), but each classifier's rejection/suspect path *is* its anomaly rule — there's no separate anomaly-detection logic beyond what speed/fuel classification already does. One `register()` call per signal covers both, avoiding a parallel registry with nothing distinct to hold.

**`ANOMALY_LOG_CAP` set equal to `TELEMETRY_HISTORY_CAP_PER_SIGNAL` (300):** no existing constant covers it (confirmed against both `shared/constants.js` and `constants.md`); this is a free parameter (AD-2) sized to match the sibling cap rather than inventing an unrelated number.

**Matrix row "fuel window resolves even with zero further readings" — resolved by staleness, not a synthetic timer (Avraham confirmed, 2026-08-19):** the fuel classifier has no wall-clock timer (I/O matrix's own constraint) — a suspect window only resolves lazily, on the next `live` classify call for that truck, whatever signal triggered it (every wire reading carries all signals together, so in normal operation this fires within one tick of the window elapsing). If a truck goes genuinely silent forever, that window state never resolves internally — but `computeEffectiveTrust` (AD-3) independently flips the truck's display to `stale` once `STALENESS_BADGE_THRESHOLD_MS` passes since `arrivalTs`, which is CM1's required alerting delivered through a different, already-tested mechanism (`effectiveTrust.test.ts`'s "time passes with no new reading" case) rather than a fabricated "trusted 0%" conjured from the absence of data. No code change made; flagging this reasoning here since the literal matrix wording (transcribed from trust-model.md) reads as a stronger promise than what a no-timer design can deliver.

## Verification

**Commands:**
- `npm test` -- expected: full suite green, including new pipeline/store tests (9 mandated FR-6/7/8 cases + NFR-1/2/3 structural)
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` typechecks the new files clean

**Manual checks (if no CLI):**
- None — this story has no UI surface; all behavior is verified through the test suite.

## Suggested Review Order

**Entry point — the pipeline's public factory (AD-1, AD-4)**

- `createPipeline({onCommit, onAnomaly})`: the four-stage assembly (ingest → order → classify → one batched commit) everything else plugs into.
  [`index.ts:74`](../../../../src/pipeline/index.ts#L74)

- Review-round fix: an empty-readings batch now short-circuits to zero commits, matching `ingestBackfill([])`'s existing behavior.
  [`index.ts:122`](../../../../src/pipeline/index.ts#L122)

**Ordering & backfill (FR-6, AD-4)**

- The order/dedupe cursor: ties count as `live`, mirroring `server.js`'s own "newest wins" rule.
  [`order.ts:41`](../../../../src/pipeline/order.ts#L41)

**Classification (FR-7, FR-8, AD-6)**

- `registerSignal`: the one signal/anomaly-rule registry. Review-round fix: duplicate registration now throws instead of silently overwriting.
  [`registry.ts:58`](../../../../src/pipeline/signals/registry.ts#L58)

- Fuel's hybrid policy, live mode: the lazy, timer-free suspect-window resolution — checked on the next classify call, not a wall-clock callback.
  [`fuel.ts:66`](../../../../src/pipeline/signals/fuel.ts#L66)

- Fuel's stateless backfill counterpart: collapses (b)/(c) to immediate resolution per CM1, since there's no future reading to wait on.
  [`fuel.ts:47`](../../../../src/pipeline/signals/fuel.ts#L47)

- Speed's two-threshold classifier: sensor-fault ceiling vs. the real-overspeed band, both resolved in one pass.
  [`speed.ts:24`](../../../../src/pipeline/signals/speed.ts#L24)

- The three always-trusted signals (position/temperature/mileage) — no plausibility rule exists for them yet.
  [`passthrough.ts:935`](../../../../src/pipeline/signals/passthrough.ts#L935)

**Store foundation (AD-5, AD-10)**

- The one capped-collection utility every history/log buffer is built from. Review-round fix: `toArray()` now returns a defensive copy, not the live internal array.
  [`boundedBuffer.ts:58`](../../../../src/store/boundedBuffer.ts#L58)

- The coalescing commit scheduler: trailing-edge throttle merging telemetry + anomaly flushes into one `set()`.
  [`store.ts:59`](../../../../src/store/store.ts#L59)

- Where pipeline output actually lands: per-signal envelope + history merge, pure so the scheduler can compose it with the obs slice.
  [`telemetrySlice.ts:57`](../../../../src/store/slices/telemetrySlice.ts#L57)

- The anomaly log's own pure reducer (AD-18) — the one legal home for rejected/suspect-resolved raw values.
  [`obsSlice.ts:56`](../../../../src/store/slices/obsSlice.ts#L56)

**The one effective-trust selector (AD-3)**

- Layers staleness (arrival clock) and `health.isDegraded` over the pipeline's per-signal trust — the only trust source a future widget reads.
  [`effectiveTrust.ts:26`](../../../../src/store/selectors/effectiveTrust.ts#L26)

**Constants**

- `ANOMALY_LOG_CAP`: the one new tunable this story adds, sized to match its sibling history cap.
  [`constants.js:48`](../../../../shared/constants.js#L48)

**Tests — review-round additions**

- The `boundedBuffer` snapshot-contract regression test — proves the `toArray()` fix.
  [`boundedBuffer.test.ts:57`](../../../../src/store/boundedBuffer.test.ts#L57)

- New file: registry registration + duplicate-registration-throws coverage.
  [`registry.test.ts:1`](../../../../src/pipeline/signals/registry.test.ts#L1)

- Fuel backfill anomaly now asserted by full content, not just length.
  [`fuel.test.ts:89`](../../../../src/pipeline/signals/fuel.test.ts#L89)

- The end-to-end pipeline integration suite — all 9 mandated FR-6/7/8 cases plus reset/backfill/empty-batch behavior.
  [`index.test.ts:44`](../../../../src/pipeline/index.test.ts#L44)

- NFR-1 coalescing-flood proof: commit count stays within the ceiling under a synthetic 12-truck burst.
  [`store.test.ts:22`](../../../../src/store/store.test.ts#L22)

