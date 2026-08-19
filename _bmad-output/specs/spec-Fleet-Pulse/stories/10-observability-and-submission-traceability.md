---
title: 'Observability and submission traceability'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 1
baseline_commit: '2972b7600843745bbb20e37eb45c6f354d453cef'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/constants.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/test-matrix.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Dispatchers have no aggregated view of detected sensor anomalies to judge "real problem or sensor bug" (FR-29), and developers have no visibility into live transport health even though the underlying counters mostly already exist unconsumed (FR-30). Separately, the submission's own traceability artifacts still carry an explicit placeholder admitting the README write-up is deferred to this final story (CAP-10).

**Approach:** Build two new registered widgets — `AnomalyView` reading the already-populated `obs.anomalyLog`, and `DevMetrics` reading the transport layer's existing read-only getters via the already-declared but unwired `setTransportCounters()` action, plus one new SSE-events/sec counter (the one FR-30 metric with no groundwork today). Then close out CAP-10: replace README's placeholder with the data-flow walkthrough and NFR-9 tire-pressure example, append the final DECISIONS.md and PROMPTS.md entries, and add the missing FR-29/FR-30 rows to test-matrix.md.

## Boundaries & Constraints

**Always:**
- `AnomalyView` reads exclusively from `store.getState().obs.anomalyLog.toArray()` (already fed live via `store.ts:117,132` from the pipeline's `onAnomaly`) — it never re-derives or re-detects anomalies itself.
- `DevMetrics` reads only from existing read-only getters — `sse-manager`'s `getDroppedMessageCount`/`getReconnectCount` (+ the new events/sec getter) and `ws-manager`'s `getDroppedMessageCount`/`getReconnectCount`/`getLastPingRttMs` — surfaced into `obsSlice.transportCounters` through the already-declared `setTransportCounters()` action, called from `bootstrap.ts`'s existing periodic tick (the same one already polling `api-client`'s `getBreakerState()` for the health slice — reused as the hook point, not as a fifth displayed metric: FR-30 and the I/O matrix below name exactly four). No new fetch or subscription path.
- Both widgets register via `registerWidget` (`registry.ts:25-33`) exactly like the four existing widgets — one new side-effect import line each in `App.tsx`, no edits to existing widget modules or `App.tsx`'s existing lines (NFR-9: registration, not modification).
- The new SSE events/sec counter follows `sse-manager.ts`'s existing counter pattern; any new sampling-window tunable lives in `shared/constants.js` — a literal anywhere else is a defect.
- `DevMetrics` and `AnomalyView` are read-only displays outside the dispatcher mutation workflow — no actions/mutations originate here.
- README's data-flow section and NFR-9 tire-pressure worked example replace the existing placeholder notice (`README.md:8-11`), not appended alongside it.
- `DECISIONS.md` gets one new `## Story 1.10 —` entry matching the existing format exactly (bolded-lead-in bullets citing FR-/NFR-/AD- ids, closing `Verified: npm test (N/N)` line). `PROMPTS.md` gets one new entry matching its existing 4-subheading format (**Tool:**, **Goal:**, **How the AI was used:**, **What I decided, corrected, or rejected:**).
- `test-matrix.md` gets new rows for FR-29/FR-30, following its existing table conventions (no such rows exist today).

**Ask First:** None anticipated — every seam (`obsSlice`, the transport getters, the registry, `App.tsx`'s import pattern) already exists per investigation; the only new primitive is an SSE-events/sec counter, a same-shape addition to `sse-manager.ts`'s existing counter pattern, not a new architectural decision.

**Never:** Modify the circuit breaker's own state machine or probe/threshold logic. Modify the pipeline's anomaly-detection rules themselves — only consume `AnomalyEntry`s already produced. Create a `docs/` directory — the architecture spine's Structural Seed was already corrected away from `docs/` to `_bmad-output/` (DECISIONS.md, story 1.1); `requirements.md`'s stale `docs/` reference is not authoritative. Build a standalone anomaly-detection dashboard beyond FR-29's aggregated list (SPEC.md's explicit non-goal). Touch other widgets' own mutation/conflict logic.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Anomalies present | `obs.anomalyLog` has entries | `AnomalyView` lists truck id, rule/type, and timestamp for each | N/A |
| No anomalies yet | `obs.anomalyLog` empty | `AnomalyView` shows an explicit empty state, never blank | N/A |
| Transport healthy | breaker closed, recent WS ping | `DevMetrics` shows live SSE events/sec, WS RTT, zero dropped/reconnect counts | N/A |
| Dropped/reconnect activity | sse/ws counters > 0 | `DevMetrics` reflects updated counts on the next tick | N/A |
| Widget throws | `AnomalyView` or `DevMetrics` render error | Contained by its own registry `ErrorBoundary`; rest of dashboard unaffected | Existing registry ErrorBoundary |

</frozen-after-approval>

## Code Map

- `shared/constants.js` -- add the SSE events/sec sampling-window tunable; no hardcoded literal elsewhere.
- `src/transport/sse-manager.ts:60-64,91-92,126-131` -- existing `getDroppedMessageCount`/`getReconnectCount` pattern to mirror; add an events/sec counter + `getEventsPerSecond()` getter here.
- `src/transport/ws-manager.ts:114-122,146-149` -- existing `getDroppedMessageCount`/`getReconnectCount`/`getLastPingRttMs` getters, read-only reuse.
- `src/transport/api-client.ts:82,322` -- `getBreakerState()` already polled into the health slice by story 9's tick; not read again for this story — DevMetrics displays exactly FR-30's four metrics, not breaker state (see Spec Change Log).
- `src/app/bootstrap.ts:113,226` -- existing periodic tick that already polls breaker state (story 9); add `setTransportCounters()` calls here from the sse/ws managers' getters, reusing this same tick. `transportCounters` is intentionally excluded from `fleet_reset`'s wipe (`resetObs()` only clears `anomalyLog`, per AD-17/AD-18) — do not add reset wiring for it.
- `src/store/slices/obsSlice.ts:18-41` -- `transportCounters`/`setTransportCounters`/`anomalyLog` already declared; consume as-is, do not rebuild.
- `src/pipeline/types.ts:37-43` -- `AnomalyEntry` shape (`ruleId`, `truckId`, `rawValue`, `readingTs`, `arrivalTs`) — read-only reference for `AnomalyView`.
- `src/ui/registry.ts:25-33` -- `registerWidget` pattern to follow verbatim, same as the four existing widgets.
- `src/app/App.tsx:14-17` -- add two new side-effect import lines only, no edits to existing lines.
- New `src/ui/widgets/anomalyView/AnomalyView.tsx` + `.module.css` -- FR-29 dispatcher anomaly list.
- New `src/ui/widgets/devMetrics/DevMetrics.tsx` + `.module.css` -- FR-30 developer metrics panel.
- `README.md:8-11` -- replace placeholder with the data-flow walkthrough and NFR-9 tire-pressure worked example.
- `DECISIONS.md` -- append the Story 1.10 entry, matching existing format.
- `PROMPTS.md` -- append the final entry, matching existing 4-subheading format.
- `_bmad-output/specs/spec-Fleet-Pulse/test-matrix.md` -- add FR-29/FR-30 rows.

## Tasks & Acceptance

**Execution:**
- [x] `shared/constants.js` -- add SSE events/sec sampling-window tunable -- FR-30
- [x] `src/transport/sse-manager.ts` -- events/sec counter + getter, mirroring existing counter pattern -- FR-30
- [x] `src/app/bootstrap.ts` -- wire `setTransportCounters()` from sse/ws getters on the existing tick (the one that also polls breaker state for the health slice) -- FR-30
- [x] `src/ui/widgets/anomalyView/AnomalyView.tsx` (+ `.module.css`, `.test.tsx`) -- dispatcher anomaly list, `registerWidget` -- FR-29
- [x] `src/ui/widgets/devMetrics/DevMetrics.tsx` (+ `.module.css`, `.test.tsx`) -- developer metrics panel, `registerWidget` -- FR-30
- [x] `src/app/App.tsx` -- two new side-effect imports -- FR-29, FR-30
- [x] Co-located tests for every new/changed file above, covering the I/O matrix -- FR-29, FR-30
- [x] `README.md` -- data-flow walkthrough + NFR-9 tire-pressure worked example, replacing the placeholder -- G5, NFR-9
- [x] `DECISIONS.md` -- append Story 1.10 entry citing FR/NFR/AD ids -- G5
- [x] `PROMPTS.md` -- append final entry documenting this story's AI usage -- G5
- [x] `_bmad-output/specs/spec-Fleet-Pulse/test-matrix.md` -- add FR-29/FR-30 rows -- G5

**Acceptance Criteria:**
- Given anomalies exist in the bounded log, when the anomaly view renders, then every entry shows truck id, rule/type, and timestamp, sourced only from `obs.anomalyLog`.
- Given the SSE/WS connections are active, when the dev metrics panel renders, then it shows live events/sec, WS ping/pong RTT, dropped-event counts, and reconnection counts, updating on the existing tick without a new fetch/subscription path.
- Given `npm test`, when it runs, then the full suite passes with no regressions, including new FR-29/FR-30 cases.
- Given `npm run lint` and `npm run build`, when run, then both are clean (`--max-warnings 0`; `tsc -b` + Vite build).
- Given README, DECISIONS.md, and PROMPTS.md, when reviewed, then each closes out CAP-10 (data flow, tire-pressure example, FR/NFR-cited decisions, final prompt-usage entry) with no placeholder text remaining.

## Spec Change Log

- **Finding:** Review (blind-hunter layer) flagged that the original Boundaries text named `api-client`'s `getBreakerState()` alongside `DevMetrics`' other read-only getters as something "surfaced into `obsSlice.transportCounters`" — but the I/O & Edge-Case Matrix in this same frozen block, and FR-30's own source text, both name exactly four metrics (SSE events/sec, WS RTT, dropped events, reconnects) with no breaker/circuit state. Two independent fresh readers (the reviewer and the implementing subagent) reached opposite conclusions from the same sentence, confirming genuine ambiguity rather than a single obvious reading.
- **Amended:** The Boundaries bullet now reads breaker polling as identifying which existing tick to reuse, not a fifth displayed metric; the Code Map and Tasks lines were reworded to match. No functional/UI code changed — the implementation (which had already read it the narrower way, per its own `DECISIONS.md` entry) was confirmed correct against FR-30's canonical text.
- **Known-bad state avoided:** A future reviewer or re-implementation reading the old wording literally could add an unrequested fifth field to `TransportCounters`/`DevMetrics`, growing scope beyond FR-30's acceptance criteria.
- **KEEP:** `DevMetrics` stays a pure four-metric read-only panel; `getBreakerState()` stays exclusively the health slice's concern (story 9), untouched by this story.

## Design Notes

SSE events/sec is sampled as a rolling count over the new constants.js window (e.g. count of messages in the last N ms, divided by N/1000), mirroring the existing dropped/reconnect counter style rather than introducing a new metrics abstraction.

No `docs/` directory is created — README.md remains the single SDD anchor, consistent with the architecture spine's already-corrected Structural Seed (DECISIONS.md, story 1.1). `requirements.md:150`'s stale `docs/` reference is a known pre-existing discrepancy, not something this story's scope covers fixing.

## Verification

**Commands:**
- `npm test` -- expected: full suite green including new anomaly-view, dev-metrics, and transport-counter tests
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` + Vite build clean

**Manual checks (if no CLI):**
- `npm start` + `npm run dev`: trigger a quirk via `/api/dev/quirk/:id` to produce an anomaly, confirm it appears in the anomaly view; watch dev metrics update live as telemetry streams; read README/DECISIONS.md/PROMPTS.md end to end and confirm no placeholder text remains.

## Suggested Review Order

**SSE events/sec — the one net-new metric**

- Every frame counts toward the rate, parseable or not — a transport-activity rate, not a parse-success rate.
  [`sse-manager.ts:160`](../../../../src/transport/sse-manager.ts#L160)

- The rolling-window getter `DevMetrics` reads; fixed-window average by design (see Design Notes), documented cold-start limitation.
  [`sse-manager.ts:243`](../../../../src/transport/sse-manager.ts#L243)

- Code-review patch: `close()` resets the window so a fresh `connect()` never inherits pre-close activity.
  [`sse-manager.ts:235`](../../../../src/transport/sse-manager.ts#L235)

**Wiring transport counters into the store**

- `TransportCounters` gains one field; the passthrough mechanism itself untouched.
  [`obsSlice.ts:24`](../../../../src/store/slices/obsSlice.ts#L24)

- `setTransportCounters()` appended to the existing staleness tick — no new interval, no new fetch path.
  [`bootstrap.ts:241`](../../../../src/app/bootstrap.ts#L241)

**Dispatcher anomaly view — a real bug caught before shipping**

- Selects `state.obs` itself, not `state.obs.anomalyLog` — the narrower selector would never see a fresh push (reference-stability bug), so this is the actual live-update fix.
  [`AnomalyView.tsx:72`](../../../../src/ui/widgets/anomalyView/AnomalyView.tsx#L72)

- Code-review patch: `data-testid` now matches `key`'s truckId+readingTs+index disambiguation.
  [`AnomalyView.tsx:50`](../../../../src/ui/widgets/anomalyView/AnomalyView.tsx#L50)

**Developer metrics panel — a plain read-only passthrough**

- Reads `obs.transportCounters` directly; no fetch or subscription of its own.
  [`DevMetrics.tsx:43`](../../../../src/ui/widgets/devMetrics/DevMetrics.tsx#L43)

- Registered like every other panel — gets the standard `ErrorBoundary` for free.
  [`DevMetrics.tsx:64`](../../../../src/ui/widgets/devMetrics/DevMetrics.tsx#L64)

**Registration**

- Two new side-effect imports, no edits to the existing four.
  [`App.tsx:18`](../../../../src/app/App.tsx#L18)

**Traceability close-out (CAP-10)**

- Data-flow walkthrough replacing the placeholder README carried since story 1.1.
  [`README.md:25`](../../../../README.md#L25)

- NFR-9's own acceptance criterion: the tire-pressure worked example, naming every seam a new signal would touch.
  [`README.md:188`](../../../../README.md#L188)

- Story 1.10 decisions entry, including the code-review pass and the breaker/`DevMetrics` scoping call this review round settled.
  [`DECISIONS.md:505`](../../../../DECISIONS.md#L505)

- Two new self-imposed FR-29/FR-30 rows, closing the test-matrix's only gap.
  [`test-matrix.md:15`](../../../../_bmad-output/specs/spec-Fleet-Pulse/test-matrix.md#L15)

**Peripherals**

- The one new tunable this story needed, with inline sizing rationale.
  [`constants.js:103`](../../../../shared/constants.js#L103)
