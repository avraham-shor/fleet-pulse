---
title: FleetPulse PRD
status: final
created: 2026-08-18
updated: 2026-08-18
---

# FleetPulse — Product Requirements Document

> **Context.** This PRD is part of the assignment submission and serves as its spec-driven-development (SDD) anchor. Every functional requirement carries a stable ID (`FR-n`) that commits, DECISIONS.md entries, and tests trace back to. The external contract (API, WebSocket messages, server failure modes) is defined by the assignment brief; the mock server that implements it, `server.js`, is **self-built as part of this submission** (interviewer-confirmed — the brief specifies the contract, not the code). We author both sides of the contract and hold both to the brief.

## 1. Vision and problem

> **North star.** We are not building the prettiest dashboard. We are building a dashboard the dispatcher can **trust**. Every trade-off in this document resolves toward data trustworthiness over visual polish.

**Vision.** FleetPulse gives dispatchers a real-time picture of the fleet they can actually trust — truck position, status, and sensor health — alongside route management that stays coordinated across concurrent dispatchers. The system detects and isolates unreliable data and conflicting actions as they happen, so dispatchers act on correct, current information instead of stale or corrupted readings.

**The problem is trust, not data.** The current dashboard displays plenty of data; the incidents that motivated this product were all failures of trust in that data:

- Two trucks were dispatched to the same address — no coordination between dispatchers acting on the same fleet state.
- A driver ran out of fuel while the dashboard showed 80% — sensor readings rendered raw, with no plausibility checking.
- A dispatcher reassigned a route another dispatcher had already changed — no conflict detection, no attribution; "nobody knew who did what."

The telemetry sources themselves are known to be unreliable: GPS updates arrive in bursts and out of order after signal loss, the fuel sensor reads a false 0% during hard braking, truck #7's speed sensor sticks at 999 km/h, and the fleet API intermittently fails under load. A dashboard that renders this stream verbatim is worse than no dashboard — it manufactures confidently wrong decisions.

**Product stance.** Every reading shown to a dispatcher is either validated or visibly annotated as suspect or stale. Every mutation is attributed to a dispatcher and protected against silent overwrites. When the system degrades, it says so — it never presents old data as fresh.

## 2. Goals and success criteria

- **G1 — Trustworthy telemetry.** All eight server failure modes are handled deliberately: anomalies detected, isolated, and annotated rather than rendered raw. Production-minded, not happy-path.
- **G2 — Legible, extensible architecture.** A reviewer can add a new sensor or vehicle type without touching existing components; the telemetry pipeline is decoupled from the UI.
- **G3 — Correct concurrency.** Optimistic locking, conflict resolution with attribution, and multi-dispatcher awareness work under real concurrent use (two-tab test).
- **G4 — Test quality on the hard parts.** ≥8 meaningful tests covering anomaly detection, batch/out-of-order processing, locking conflicts, and ghost presence — not "it renders" tests.
- **G5 — Full traceability.** Every requirement in this PRD maps to implementation and tests; decisions trace back to requirements (SDD evaluation parameter).

**Definition of success.** The reviewer should close the repo thinking: the code is easy to understand and extend, every assignment requirement can be traced to its implementation and test, and the system was designed for real faults rather than the happy path.

| Evaluation parameter | Where this PRD answers it |
|---|---|
| Spec-Driven Development | This document + stable FR IDs + DECISIONS.md tracing |
| Architecture | G2, NFR section, addendum (stack, pipeline, and server design decisions) |
| Security | Route-mutation FRs (headers, locking, confirmations, validation) |
| Performance | NFR section (12 trucks × 2 s updates, batch bursts, bounded memory) |
| Observability | Resilience and observability FR groups |
| Tests | G4 + per-FR test hooks |

**Counter-metrics** (what must *not* happen while chasing the goals):

- **CM1 — No suppressed emergencies.** Anomaly filtering must never mask a genuine critical reading: a real 0% fuel or a real sustained overspeed must still alert. (Tested explicitly.)
- **CM2 — No alert fatigue.** Trust annotations inform without drowning the dispatcher; suspect data is flagged inline, not turned into a modal storm.
- **CM3 — No breadth over depth.** Within the submission deadline, depth on the eight failure modes outranks bonus-feature breadth — the brief explicitly scores a thoughtful partial solution above a naive complete one.

## 3. Functional requirements

FR IDs are stable and globally numbered; commits, DECISIONS.md entries, and tests reference them. Requirements marked *(mandated test)* correspond to the assignment's required test areas (minimum 8 meaningful cases); the full test matrix is in §5.

**Failure-mode coverage.** The eight intentional failure modes the assignment mandates — implemented faithfully by the self-built mock server (§7) — each traced to its client-side handling requirements:

| # | Server failure mode | Handled by |
|---|---|---|
| 1 | GPS batch — 10–30 buffered readings at once | FR-3, NFR-2 |
| 2 | Fuel sensor false 0% during hard braking (2–4 s) | FR-8 |
| 3 | Speed sensor stuck at 999 km/h (truck #7) | FR-7 |
| 4 | 409 on route version mismatch (optimistic locking) | FR-12, FR-13 |
| 5 | Out-of-order SSE timestamps | FR-6 |
| 6 | Ghost dispatcher presence — disconnect delayed up to 10 s | FR-19 |
| 7 | 503 under load with `Retry-After` on fleet fetch | FR-24, FR-25, FR-26 |
| 8 | PATCH race — 409 when a route is reassigned mid-processing | FR-12, FR-13 — same conflict path as #4; pessimistic UI means there is no optimistic state to roll back |

**Trust vocabulary.** Five states, used consistently across every view; a value is always in exactly one, and each is visually distinct:

- **Trusted** — validated and current.
- **Suspect** — plausibility under review; last trusted value shown with a "validating" badge (the dispatcher-facing label for the suspect state).
- **Sensor fault** — reading rejected as impossible; last plausible value shown with a fault badge, raw value in the anomaly log.
- **Stale** — no fresh contact beyond the staleness threshold; age badge shown.
- **Degraded** — a system-level data source is down; the global banner names it (degraded mode, FR-26).

### A. Live fleet overview

- **FR-1.** The dashboard shows all 12 trucks on a map (or coordinate grid) with positions updating live from the telemetry stream.
- **FR-2.** Each truck's status — `active` / `idle` / `maintenance` — is visually distinct at a glance.
- **FR-3.** When a GPS batch arrives (10–30 buffered readings), the truck's marker snaps to the newest-by-timestamp position — not the last array element — and the batch is drawn as a thin, timestamp-sorted trail polyline (bounded by the per-truck telemetry history cap, §5) showing where the truck was during signal loss. A batch never renders as separate markers and never visibly stalls the UI. *(mandated test)*
- **FR-4.** Each truck shows a freshness indicator when its telemetry age exceeds a staleness threshold. Age runs on the **arrival clock** — time since the last accepted reading — so a batch replaying old timestamps still counts as fresh contact; the reading's own timestamp is visible on demand. Clock skew is assumed negligible against the localhost mock and noted as a production caveat.

### B. Telemetry integrity engine (cross-cutting)

- **FR-5.** Every inbound reading passes validation before it can affect anything a dispatcher sees; no raw, unvalidated value is ever rendered as current truth. On cold start or after a reset, before any trusted history exists, values render as "no trusted reading yet" — never a guess; a first-ever 0% fuel reading is treated as a pending FR-8 case (c), failing toward alerting.
- **FR-6.** Readings are applied in reading-timestamp order, not arrival order. A reading older than the truck's current state never overwrites newer data — it **backfills** the bounded, timestamp-sorted history that feeds trails and charts, but never current state. *(mandated test)*
- **FR-7.** Speed readings are classified against two thresholds. *(mandated test — one case per branch)*
  - Above the **sensor-fault ceiling** (physically impossible for a delivery truck; the stuck sensor's 999 km/h sits far above it) → **sensor fault**: the dispatcher sees the last plausible speed with a "sensor fault" badge, the raw value is preserved in the anomaly log, and recovery clears the badge.
  - Between the **overspeed limit** and the ceiling → **real**: a genuine overspeed alert reaches the dispatcher immediately, from the first reading (CM1 — a real emergency is never masked as a sensor fault).
- **FR-8.** Fuel readings of 0% are classified by plausibility (hybrid policy). *(mandated test)*
  - **(a)** Prior trusted level already low → alert immediately.
  - **(b)** Implausible cliff-drop from a healthy level → suspect state: last trusted value shown with a "validating" badge.
  - **(c)** 0% persisting beyond the suspect window → accepted as real and alerted.
  - The suspect window is measured in **reading timestamps, not wall-clock arrival**: a batch whose readings already cover the window (including the recovery) resolves immediately with no artificial wait, and if the window closes with no further readings at all, the 0% is treated as real and alerted.
  - Ordering (FR-6) runs before classification — a 0% older than the current trusted state is discarded upstream and never reopens a window.
  - Uncertainty always fails toward alerting, never toward suppression (CM1).
- **FR-9.** Every detected anomaly (type, truck, raw value, timestamps) is recorded to a bounded anomaly log that feeds the observability views (Group G).

### C. Route management and concurrency

- **FR-10.** A dispatcher can create a route and assign it to a truck. Inputs are validated before submission, and every mutation carries the acting dispatcher's identity. Assigning to a truck in `maintenance` triggers the same warn-and-confirm flow as FR-34.
- **FR-34.** *(added at reviewer gate)* The route-creation dialog shows the chosen truck's current assignment state — an existing active route and who assigned it — and keeps it live while the dialog is open (same events as FR-31). Creating a route for a truck that already has an active one requires explicit confirmation after a clear warning. This is client-side prevention for the founding-incident class — concurrent, mutually blind route creation — which server-side locking cannot cover: a POST has no version to check.
- **FR-11.** Route status transitions are enumerated: `assigned` → `in-progress` or `cancelled`; `in-progress` → `completed` or `cancelled`; `completed` and `cancelled` are terminal. Reassignment (FR-14) is legal for `assigned` and `in-progress` routes and preserves status. The UI offers only transitions legal from its current knowledge; a transition invalidated by a race lands as a conflict and flows through FR-13.
- **FR-12.** All route updates use optimistic locking (version-checked writes). A stale write is rejected, never silently applied. Mutations are **pessimistic in the UI**: on-screen state changes only after server confirmation, the affected control shows an in-flight indicator meanwhile, and a failed mutation leaves local state untouched. A non-conflict failure surfaces as a visible error state — nothing fails silently. *(mandated test)*
- **FR-13.** On any conflict — a stale-version rejection or a mid-processing race (failure modes #4 and #8):
  - The dispatcher sees **who** made the conflicting change and both versions side by side — the dispatcher's intended change vs. the current server state — and chooses how to proceed. No silent overwrite, no silent discard.
  - Re-applying resubmits against the fresh version (new `If-Match`).
  - Attribution is guaranteed by design: the self-built server includes the conflicting dispatcher's identity in every 409 response, so the conflict view always names who made the conflicting change (OQ-4, resolved).
- **FR-14.** Routes can be reassigned between trucks. Reassign and cancel are destructive actions and require explicit confirmation.
- **FR-15.** A route audit trail shows who changed what and when, built from route lifecycle events.
- **FR-31.** *(added from UJ-1)* While a dispatcher has a route open for editing, an incoming change to that route by another dispatcher is surfaced inline — who changed it and that the version has moved — before a save is attempted. Conflict *avoidance* ahead of conflict *resolution*; powered entirely by events the server already pushes.

### D. Dispatcher presence

- **FR-16.** A dispatcher registers by name over WebSocket, receives an identity used for all subsequent actions, and maintains keepalive. While the dispatcher is unregistered (socket down), mutations are disabled with a visible reason; viewing continues. A reconnect issues a fresh identity — one person's audit entries may span two identities mid-shift; an accepted limit, documented honestly.
- **FR-17.** All currently active dispatchers are visible.
- **FR-18.** Each dispatcher's currently viewed truck is broadcast and shown to the others (collaborative viewing indicator). The protocol expresses "viewing nothing" explicitly — `viewing_truck` with a null truck id clears the indicator, and the server broadcasts the clear (OQ-5, resolved by design — the server is self-built). The liveness timeout (§5) still bounds indicators from a dispatcher that vanishes silently.
- **FR-19.** Presence is keyed by the server-issued dispatcher identity — never by name; two dispatchers sharing a name are two legitimate entries. *(mandated test)*
  - A disconnect arriving late (up to 10 s), duplicated, or out of order never breaks the UI and never leaves phantom state.
  - A presence entry with no sign of life for the liveness timeout is removed — which also retires the stale identity a reconnect re-registration leaves behind.
  - A disconnect for an already-removed identity is a silent no-op.

### E. Vehicle detail panel

- **FR-20.** Selecting a truck opens live detail — speed, fuel, engine temperature, mileage — with integrity annotations carried through (a suspect value looks suspect here too).
- **FR-21.** Speed, fuel, and temperature render as live-updating charts or gauges over a bounded recent-history window.
- **FR-22.** A dispatcher can send an alert to a specific truck; input is validated.
- **FR-23.** The panel shows the truck's assigned route details.
- **FR-32.** *(added at source reconciliation)* An alert sent to a truck is visible to all dispatchers, not only the sender — shared awareness — via the broadcast alert event.

### F. Resilience and degraded mode

- **FR-24.** Failed fleet fetches (503) are retried, honoring the server's `Retry-After`.
- **FR-25.** A circuit breaker guards the fleet endpoint.
  - Three consecutive failed HTTP attempts returning 503 (each completed attempt counts, retries included) open the circuit and enter degraded mode on cached data.
  - Recovery probes run no more often than the probe interval **or the last `Retry-After`, whichever is longer** — the breaker never violates the backpressure principle FR-24 establishes.
  - A successful probe closes the circuit automatically.
- **FR-26.** Degraded mode is entered whenever live data is compromised — the telemetry stream is down or fleet fetches are failing — and it is explicit: a global banner plus per-truck age badges. Old data is never presented as fresh.
  - The banner is a disjunction of **named conditions** (telemetry stream down; fleet fetches failing / circuit open), each with its own set-and-clear rule and a short healthy-period hysteresis before clearing, so the banner never flaps (CM2).
  - It names *what* is degraded: live positions alongside stale route metadata is a legal, labeled state.
  - The Tier-2 circuit breaker (FR-25) feeds this same mode; it does not define it.
- **FR-27.** SSE and WebSocket connections reconnect automatically with backoff; on WebSocket reconnect the dispatcher re-registers and presence state rebuilds.
- **FR-28.** A failure inside one dashboard widget is contained; the rest of the dashboard keeps working.
- **FR-33.** *(added at source reconciliation)* Unknown or dev-only server messages (e.g., fleet reset) never break the UI. A fleet reset triggers a clean state refresh: local state — telemetry history, anomaly log, and cached route and presence state — is wiped and refetched from the server; if the circuit is open, reset triggers an immediate probe.

### G. Observability

- **FR-29.** Dispatcher-facing anomaly view: aggregated sensor anomalies with timestamps, helping distinguish real problems from sensor bugs.
- **FR-30.** Developer-facing observability panel: SSE events/sec, WebSocket latency (measured as ping/pong round-trip), dropped/discarded events, reconnection counts. Not part of the dispatcher workflow.

## 4. User journey — two dispatchers, one route (UJ-1)

**Dana and Yossi**, both mid-shift. Truck #3 is finishing its route, and both decide to handle it at nearly the same moment. Yossi is a second ahead.

1. **Presence, before anything happens.** Dana opens truck #3's route. She already sees Yossi's viewing indicator on the truck (FR-18) — like a shared document showing who else is there. *Honest limit:* the assignment-specified protocol only broadcasts truck-level viewing, so the indicator means "Yossi is looking at truck #3," not "Yossi is editing this route." The server is self-built, but we implement the brief's contract faithfully rather than invent a richer one; truck-level presence is the honest proxy.
2. **Conflict avoidance.** Yossi saves a reassignment. The server pushes the route event to everyone, and Dana's open editor immediately shows a non-blocking inline notice: *"This route was just changed by Yossi."* (FR-31). She can refresh her view before wasting a save — most conflicts die here, before they become conflicts.
3. **Conflict resolution.** Dana saves anyway — or the notice raced her click. The server rejects the stale write (FR-12), and her screen shows a clear message: the route changed, **Yossi** changed it, and both versions side by side — her intended change vs. the current state (FR-13). She chooses: adopt Yossi's version, re-apply her change on top of the fresh version, or back out. Nothing is silently lost or silently overwritten.
4. **The other side.** Yossi sees Dana's viewing indicator the whole time (FR-18) but is never interrupted by her conflict. If Dana overrides, he learns the way everyone learns — the live update arrives, his view refreshes, and the audit trail (FR-15) shows "changed by Dana."
5. **The record.** The audit trail holds the whole exchange — who did what, when. *"Nobody knew who did what"* cannot happen here.

## 5. Non-functional requirements and quality

### Performance

- **NFR-1.** Sustained load — 12 trucks × 2-second updates — runs without degradation; state updates are coalesced so rendering cost tracks screen-refresh needs, not raw event rate. *Verified by:* counting state-commits under a synthetic event flood — the coalescing ceiling holds.
- **NFR-2.** GPS bursts (10–30 readings, possibly several trucks at once) are processed as a unit. *Verified by:* a unit test ingesting a 30-reading batch within the batch-processing budget (§5, Tunable constants).
- **NFR-3.** Every in-memory collection is bounded — telemetry history, anomaly log, audit trail — so memory cannot leak over an 8-hour shift. *Verified structurally, not by soak:* every cap is enforced in code and asserted in a test; the 8-hour claim follows from bounded buffers, with a soak run noted in README as future verification.

### Security and safety

- **NFR-4.** Every mutating request carries the acting dispatcher's identity (`X-Dispatcher-Id`); no anonymous writes.
- **NFR-5.** All route mutations are version-checked (`If-Match` optimistic locking); a stale write can never silently win.
- **NFR-6.** Destructive actions — cancel, reassign — require explicit confirmation (FR-14).
- **NFR-7.** All user input is validated before submission: types, ranges, required fields.
- **NFR-8.** Server-originated text (dispatcher names, route fields) is treated as untrusted display content — rendered, never interpreted.

### Extensibility

- **NFR-9.** Adding a new telemetry signal, anomaly rule, or dashboard widget is a **registration, not a modification** — existing components are not edited to accommodate it. Acceptance: README traces one worked example (how a hypothetical tire-pressure sensor would slot into the pipeline and UI).

### Test matrix (assignment-mandated areas → requirements)

| Test area | Requirement | Minimum cases |
|---|---|---|
| GPS batch processing | FR-3 | 1 |
| Out-of-order timestamps | FR-6 | 2 — older reading never overwrites current state; backfill + equal-timestamp/in-batch edge |
| Fuel: real 0% vs. glitch | FR-8 | 4 — already-low → instant alert; cliff-drop → suspect window; persists → real alert; batch containing recovery resolves with no wall-clock wait |
| Speed: 999 km/h filtering + real overspeed | FR-7 | 2 — sensor-fault branch masked; 120–200 km/h raises a real alert |
| Optimistic locking / conflict flow | FR-12, FR-13 | 2 — stale-version 409; mid-processing race 409 through the same path |
| Ghost dispatcher presence | FR-19 | 3 — late/duplicate disconnect is a safe no-op; liveness timeout removes a silent ghost; a late disconnect never removes a re-registered dispatcher (new identity) |
| Circuit breaker *(self-imposed)* | FR-25 | 1 |
| Busy-truck creation guard *(self-imposed)* | FR-34 | 1 |

Sixteen or more cases total — the six mandated areas alone account for fourteen, comfortably beyond the minimum of eight, before the two self-imposed cases. No "it renders" tests.

### Tunable constants

All values below are `[ASSUMPTION]` — deliberate defaults, adjustable in one place, each defensible in review:

| Constant | Default | Rationale |
|---|---|---|
| Overspeed alert limit | 120 km/h | Above this and below the ceiling = real overspeed → immediate dispatcher alert (CM1) |
| Sensor-fault ceiling | 200 km/h | Physically impossible for a delivery truck; above this = sensor fault, value masked and logged |
| Fuel "already low" threshold | 10% | Below this, a 0% reading is plausible → alert immediately (CM1) |
| Fuel suspect/debounce window | 5 s | Documented glitch is 2–4 s; margin included; fails toward alerting |
| Staleness badge threshold | 10 s | Five missed 2-second update cycles |
| Presence liveness timeout | 30 s | No event from a dispatcher for this long → entry removed; covers never-arriving disconnects and reconnect duplicates |
| Telemetry history per truck | ~300 readings (≈10 min) | Bounds charts and trails (NFR-3) |
| Render coalescing ceiling | ≤10 state-commits/sec, global | One batched commit covers all trucks; above human-perceptible need; absorbs SSE floods (NFR-1) |
| Breaker probe interval | 10 s, or last `Retry-After` if longer | Recovery probing never violates server backpressure (FR-24, FR-25) |
| Reconnect backoff (SSE/WS) | 1 s doubling to a 15 s cap | Fast recovery without hammering a struggling server (FR-27) |
| Batch-processing budget | 50 ms per 30-reading batch | Unit-testable proxy for "no visible stall" (NFR-2) |
| Banner clear hysteresis | 5 s healthy | The degraded banner never flaps (CM2, FR-26) |

## 6. Scope and sequencing

Scope is tiered; a tier begins only when the previous one is done and green (CM3 — depth over breadth).

- **Tier 1 — Core.** Everything the assignment mandates: FR-1–FR-24, FR-26–FR-29, FR-31–FR-34 — including FR-13 **in full**: the side-by-side conflict chooser is the brief's flagged senior-level design challenge and is not cuttable.
- **Tier 2 — Selected bonuses.** FR-25 — circuit breaker extending degraded mode; FR-30 — developer observability panel.
- **Tier 3 — Stretch, time permitting, in order.** (1) Filterable fleet view — pure client-side, cheapest; (2) keyboard shortcuts; (3) geofencing alerts. The standalone anomaly-detection dashboard is deliberately excluded: FR-29 already delivers its value.
- **Out of scope.** Deviating from the assignment-specified server contract (the server is self-built per §7, but its client-facing API, message set, and failure modes follow the brief exactly; dev-only contract-neutral test hooks are an architecture decision, OQ-6); authentication and real user accounts; persistence beyond the session; browsers beyond latest Chrome; visual polish beyond legibility — per the north star, we are building trust, not beauty.

**Sequencing intent.** The self-built mock server (§7) comes first — every other line of work consumes it, and authoring it fixes the emission parameters the client thresholds pair with (OQ-3). Then the telemetry integrity pipeline (Group B) — the heart — with its tests written alongside, not deferred; then fleet overview (A), routes and concurrency (C), presence (D), vehicle detail (E), resilience (F), and observability (G). Detailed breakdown belongs to the epics/stories phase, not this document.

## 7. Deliverables and submission

- **Submission due:** 2026-08-19.
- Running app via `npm install && npm start`; tests via `npm test` (≥8 meaningful cases per §5).
- **`server.js` — the mock server, self-built** (interviewer-confirmed: the brief provides the contract, not the code), in the repo: Express + `ws` only, HTTP on :3000, WebSocket at `/ws`, SSE at `GET /api/telemetry/stream`, 12 trucks, all eight failure modes implemented faithfully.
- **README.md** — setup; architecture overview with the data flow from SSE/WS through the pipeline to the UI; key decisions and trade-offs; multi-dispatcher conflict handling; known issues; what's next.
- **PROMPTS.md** — AI usage journal, maintained throughout, not reconstructed at the end.
- **DECISIONS.md** — decision log; every entry references the FR/NFR it serves.
- **This PRD + addendum** — included in the repo as the SDD anchor.
- **Traceability convention:** commits reference FR IDs (e.g., `FR-8: hybrid fuel classifier`).
- Before submission, every open question (§8) is closed and its decision recorded in DECISIONS.md.

## 8. Open questions

- **OQ-1.** Map rendering: Leaflet vs. simple coordinate grid (map quality is not graded). Owner: Avraham; decide at architecture.
- **OQ-2.** Chart backfill: fetch telemetry history when the detail panel opens, or build charts from the live stream only. Owner: Avraham; decide at architecture.
- **OQ-3.** The tunable constants (§5) are authoritative rather than observed — we author the stream that produces them. The server's emission parameters (batch sizes, glitch windows, stuck-sensor cadence) and the client thresholds are fixed together at architecture, as one source of truth, before tests freeze them. Owner: Avraham.
- **OQ-4.** *Resolved 2026-08-18.* The server is self-built, so this flipped from a protocol verification to a design decision: every 409 response carries the conflicting dispatcher's identity (FR-13). The approximate-attribution fallback is deleted.
- **OQ-5.** *Resolved 2026-08-18.* Same flip: `viewing_truck` accepts a null truck id meaning "viewing nothing," and the server broadcasts the clear (FR-18).
- **OQ-6.** Dev-only deterministic quirk triggers in the self-built server — forcing a specific failure mode on demand, for tests and the defense-interview demo. Must stay contract-neutral (the graded client never depends on them). Owner: Avraham; decide at architecture.

No open question blocks UX, architecture, or story breakdown — OQ-1–3 and OQ-6 are architecture-level choices; OQ-4–5 are resolved.
