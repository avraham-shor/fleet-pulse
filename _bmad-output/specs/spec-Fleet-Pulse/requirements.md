# FleetPulse — Requirements Catalog

Line-item contract behind the SPEC kernel. FR/NFR ids are **stable and globally numbered**; commits, `DECISIONS.md` entries, and test names reference them. Grouping A–G matches the capability groups in `SPEC.md`. Trust-state vocabulary: [trust-model.md](trust-model.md). Thresholds: [constants.md](constants.md). Mandated test coverage: [test-matrix.md](test-matrix.md).

## Goals

- **G1 — Trustworthy telemetry.** All eight server failure modes handled deliberately: anomalies detected, isolated, annotated — never rendered raw.
- **G2 — Legible, extensible architecture.** A reviewer can add a sensor or vehicle type without touching existing components; the telemetry pipeline is decoupled from the UI.
- **G3 — Correct concurrency.** Optimistic locking, conflict resolution with attribution, and multi-dispatcher awareness hold under real concurrent use (two-tab test).
- **G4 — Test quality on the hard parts.** ≥8 meaningful tests over anomaly detection, batch/out-of-order processing, locking conflicts, and ghost presence. No "it renders" tests.
- **G5 — Full traceability.** Every requirement maps to implementation and test; every decision traces back to a requirement.

## Counter-metrics

What must not happen while chasing the goals. Each is a binding constraint in `SPEC.md`.

- **CM1 — No suppressed emergencies.** Anomaly filtering never masks a genuine critical reading: a real 0% fuel or a real sustained overspeed still alerts.
- **CM2 — No alert fatigue.** Trust annotations inform without drowning the dispatcher; suspect data is flagged inline, never a modal storm.
- **CM3 — No breadth over depth.** Depth on the eight failure modes outranks bonus-feature breadth.

## Failure-mode coverage

The eight intentional failure modes the assignment mandates, implemented faithfully by the self-built mock server, each traced to its client-side handling.

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

## A. Live fleet overview

- **FR-1.** All 12 trucks appear on a map or coordinate grid, positions updating live from the telemetry stream.
- **FR-2.** Each truck's status — `active` / `idle` / `maintenance` — is visually distinct at a glance.
- **FR-3.** On a GPS batch (10–30 buffered readings), the marker snaps to the **newest-by-timestamp** position — not the last array element — and the batch draws as a thin timestamp-sorted trail polyline (bounded by the per-truck history cap) showing where the truck was during signal loss. A batch never renders as separate markers and never visibly stalls the UI. *(mandated test)*
- **FR-4.** A truck shows a freshness indicator once its telemetry age exceeds the staleness threshold. Age runs on the **arrival clock** — time since the last accepted reading — so a batch replaying old timestamps still counts as fresh contact; the reading's own timestamp is visible on demand.

## B. Telemetry integrity engine (cross-cutting)

- **FR-5.** Every inbound reading passes validation before it can affect anything a dispatcher sees; no raw, unvalidated value is ever rendered as current truth. Before any trusted history exists (cold start, post-reset), values render "no trusted reading yet" — never a guess; a first-ever 0% fuel reading is a pending FR-8(c) case, failing toward alerting.
- **FR-6.** Readings apply in **reading-timestamp order**, not arrival order. A reading older than the truck's current state never overwrites newer data — it **backfills** the bounded, timestamp-sorted history feeding trails and charts. *(mandated test)*
- **FR-7.** Speed is classified against two thresholds. *(mandated test — one case per branch)*
  - Above the **sensor-fault ceiling** → sensor fault: last plausible speed shown with a fault badge, raw value preserved in the anomaly log, recovery clears the badge.
  - Between the **overspeed limit** and the ceiling → real: a genuine overspeed alert reaches the dispatcher immediately, from the first reading (CM1).
- **FR-8.** Fuel readings of 0% are classified by plausibility (hybrid policy). *(mandated test)*
  - **(a)** Prior trusted level already low → alert immediately.
  - **(b)** Implausible cliff-drop from a healthy level → suspect: last trusted value shown with a "validating" badge.
  - **(c)** 0% persisting beyond the suspect window → accepted as real and alerted.
  - The suspect window is measured in **reading timestamps, not wall-clock arrival**: a batch whose readings already cover the window (recovery included) resolves immediately with no artificial wait; a window that closes with no further readings at all resolves to real and alerts.
  - Ordering (FR-6) runs before classification — a 0% older than current trusted state is discarded upstream and never reopens a window.
  - Uncertainty always fails toward alerting, never suppression (CM1).
- **FR-9.** Every detected anomaly (type, truck, raw value, timestamps) is recorded to a bounded anomaly log feeding the observability views (Group G).

## C. Route management and concurrency

- **FR-10.** A dispatcher can create a route and assign it to a truck. Inputs are validated before submission; every mutation carries the acting dispatcher's identity. Assigning to a truck in `maintenance` triggers the FR-34 warn-and-confirm flow.
- **FR-11.** Route status transitions are enumerated: `assigned` → `in-progress` | `cancelled`; `in-progress` → `completed` | `cancelled`; `completed` and `cancelled` are terminal. Reassignment (FR-14) is legal for `assigned` and `in-progress` and preserves status. The UI offers only transitions legal from its current knowledge; a transition invalidated by a race lands as a conflict and flows through FR-13.
- **FR-12.** All route updates use optimistic locking (version-checked writes). A stale write is rejected, never silently applied. Mutations are **pessimistic in the UI**: on-screen state changes only after server confirmation, the affected control shows an in-flight indicator meanwhile, and a failed mutation leaves local state untouched. A non-conflict failure surfaces as a visible error state — nothing fails silently. *(mandated test)*
- **FR-13.** On any conflict — stale-version rejection or mid-processing race (failure modes #4 and #8):
  - The dispatcher sees **who** made the conflicting change and both versions side by side — their intended change vs. current server state — and chooses how to proceed. No silent overwrite, no silent discard.
  - Re-applying resubmits against the fresh version (new `If-Match`).
  - Attribution is guaranteed by design: every 409 response carries the conflicting dispatcher's id and display name, so the conflict view never depends on a presence lookup.
- **FR-14.** Routes can be reassigned between trucks. Reassign and cancel are destructive and require explicit confirmation.
- **FR-15.** A route audit trail shows who changed what and when, accumulated from route lifecycle events. Session-scoped: a late joiner sees a partial trail — accepted and documented.
- **FR-31.** While a dispatcher has a route open for editing, an incoming change to that route by another dispatcher surfaces inline — who changed it, and that the version has moved — **before** a save is attempted. Conflict avoidance ahead of conflict resolution; costs no new transport, since route events already broadcast to all clients.
- **FR-34.** The route-creation dialog shows the chosen truck's current assignment state — existing active route and who assigned it — and keeps it live while the dialog is open (same events as FR-31). Creating a route for a truck that already has an active one requires explicit confirmation after a clear warning. Client-side prevention for the founding-incident class — concurrent, mutually blind route creation — which server-side locking cannot cover: a POST has no version to check.

## D. Dispatcher presence

- **FR-16.** A dispatcher registers by name over WebSocket, receives an identity used for all subsequent actions, and maintains keepalive. While unregistered (socket down), mutations are disabled with a visible reason; viewing continues. A reconnect issues a fresh identity — one person's audit entries may span two identities mid-shift; an accepted, documented limit.
- **FR-17.** All currently active dispatchers are visible.
- **FR-18.** Each dispatcher's currently viewed truck is broadcast and shown to the others. The protocol expresses "viewing nothing" explicitly — `viewing_truck` with a null truck id clears the indicator, and the server broadcasts the clear. The liveness timeout still bounds indicators from a dispatcher that vanishes silently.
  - *Honest limit:* the brief's protocol broadcasts **truck-level** viewing only. The indicator means "X is looking at truck #3," not "X is editing this route." Truck-level viewing is the honest proxy; the protocol is implemented faithfully rather than extended.
- **FR-19.** Presence is keyed by the server-issued dispatcher identity — never by name; two dispatchers sharing a name are two legitimate entries. *(mandated test)*
  - A disconnect arriving late (up to 10 s), duplicated, or out of order never breaks the UI and never leaves phantom state.
  - A presence entry with no sign of life for the liveness timeout is removed — which also retires the stale identity a reconnect re-registration leaves behind.
  - A disconnect for an already-removed identity is a silent no-op.

## E. Vehicle detail panel

- **FR-20.** Selecting a truck opens live detail — speed, fuel, engine temperature, mileage — with integrity annotations carried through: a suspect value looks suspect here too.
- **FR-21.** Speed, fuel, and temperature render as live-updating charts or gauges over a bounded recent-history window.
- **FR-22.** A dispatcher can send an alert to a specific truck; input is validated.
- **FR-23.** The panel shows the truck's assigned route details.
- **FR-32.** An alert sent to a truck is visible to all dispatchers, not only the sender — shared awareness — via the broadcast alert event.

## F. Resilience and degraded mode

- **FR-24.** Failed fleet fetches (503) are retried, honoring the server's `Retry-After`.
- **FR-25.** A circuit breaker guards the fleet endpoint.
  - Three consecutive failed HTTP attempts returning 503 (each completed attempt counts, retries included) open the circuit and enter degraded mode on cached data.
  - Recovery probes run no more often than the probe interval **or the last `Retry-After`, whichever is longer** — the breaker never violates the backpressure principle FR-24 establishes.
  - A successful probe closes the circuit automatically.
- **FR-26.** Degraded mode is entered whenever live data is compromised — telemetry stream down or fleet fetches failing — and it is explicit: a global banner plus per-truck age badges. Old data is never presented as fresh.
  - The banner is a disjunction of **named conditions** (telemetry stream down; fleet fetches failing / circuit open), each with its own set-and-clear rule and a short healthy-period hysteresis before clearing, so the banner never flaps (CM2).
  - It names *what* is degraded: live positions alongside stale route metadata is a legal, labeled state.
  - The circuit breaker (FR-25) feeds this mode; it does not define it.
- **FR-27.** SSE and WebSocket connections reconnect automatically with backoff; on WebSocket reconnect the dispatcher re-registers and presence state rebuilds.
- **FR-28.** A failure inside one dashboard widget is contained; the rest of the dashboard keeps working.
- **FR-33.** Unknown or dev-only server messages never break the UI. A fleet reset triggers a clean state refresh: telemetry history, anomaly log, and cached route and presence state are wiped and refetched; if the circuit is open, reset triggers an immediate probe.

## G. Observability

- **FR-29.** Dispatcher-facing anomaly view: aggregated sensor anomalies with timestamps, helping distinguish real problems from sensor bugs.
- **FR-30.** Developer-facing observability panel: SSE events/sec, WebSocket latency (ping/pong round-trip), dropped/discarded events, reconnection counts. Not part of the dispatcher workflow.

## Non-functional requirements

### Performance

- **NFR-1.** Sustained load — 12 trucks × 2-second updates — runs without degradation; state updates are coalesced so rendering cost tracks screen-refresh needs, not raw event rate. *Verified by:* counting state-commits under a synthetic event flood.
- **NFR-2.** GPS bursts (10–30 readings, possibly several trucks at once) are processed as a unit. *Verified by:* a unit test ingesting a 30-reading batch within the batch-processing budget.
- **NFR-3.** Every in-memory collection is bounded — telemetry history, anomaly log, audit trail — so memory cannot leak over an 8-hour shift. *Verified structurally, not by soak:* every cap is enforced in code and asserted in a test; a soak run is noted in README as future verification.

### Security and safety

- **NFR-4.** Every mutating request carries the acting dispatcher's identity (`X-Dispatcher-Id`); no anonymous writes.
- **NFR-5.** All route mutations are version-checked (`If-Match`); a stale write can never silently win.
- **NFR-6.** Destructive actions — cancel, reassign — require explicit confirmation.
- **NFR-7.** All user input is validated before submission: types, ranges, required fields.
- **NFR-8.** Server-originated text (dispatcher names, route fields) is untrusted display content — rendered, never interpreted.

### Extensibility

- **NFR-9.** Adding a new telemetry signal, anomaly rule, or dashboard widget is a **registration, not a modification** — existing components are not edited to accommodate it. *Acceptance:* README traces one worked example (how a hypothetical tire-pressure sensor slots into the pipeline and UI).

## Scope tiers

A tier begins only when the previous one is done and green (CM3).

- **Tier 1 — Core.** Everything the assignment mandates: FR-1–FR-24, FR-26–FR-29, FR-31–FR-34 — including FR-13 **in full**: the side-by-side conflict chooser is the brief's flagged senior-level design challenge and is not cuttable.
- **Tier 2 — Selected bonuses.** FR-25 (circuit breaker extending degraded mode); FR-30 (developer observability panel).
- **Tier 3 — Stretch, in order, time permitting.** (1) Filterable fleet view — pure client-side, cheapest; (2) keyboard shortcuts; (3) geofencing alerts.

**Sequencing intent.** The self-built mock server comes first — every other line of work consumes it, and authoring it fixes the emission parameters the client thresholds pair with. Then the telemetry integrity pipeline (B) with its tests written alongside, not deferred; then fleet overview (A), routes and concurrency (C), presence (D), vehicle detail (E), resilience (F), observability (G).

## Deliverables

- **Submission due 2026-08-19.** Local-only: no deploy, no persistence, no CI — the submission runs on the evaluator's machine.
- Running app via `npm install && npm start`; tests via `npm test` (≥8 meaningful cases; see [test-matrix.md](test-matrix.md)).
- **`server.js`** — the self-built mock server, in the repo: Express + `ws` only, HTTP on :3000, WebSocket at `/ws`, SSE at `GET /api/telemetry/stream`, 12 trucks, all eight failure modes implemented faithfully.
- **README.md** — setup; architecture overview with the data flow from SSE/WS through the pipeline to the UI; key decisions and trade-offs; multi-dispatcher conflict handling; known issues; what's next; the NFR-9 tire-pressure worked example.
- **PROMPTS.md** — AI usage journal, maintained throughout, not reconstructed at the end.
- **DECISIONS.md** — decision log; every entry references the FR/NFR it serves. Every open question raised during planning is closed before submission with its decision recorded here; all six PRD open questions are already closed (OQ-4/OQ-5 at the PRD gate; OQ-1, OQ-2, OQ-3, OQ-6 by the architecture spine).
- **PRD + addendum + architecture spine** — shipped in the repo (`docs/`) as the SDD anchor.
- The submission is a Git repository (`git init` is the first build step); commits reference FR ids (e.g. `FR-8: hybrid fuel classifier`).
