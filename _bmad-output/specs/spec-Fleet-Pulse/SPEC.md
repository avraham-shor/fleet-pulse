---
id: SPEC-Fleet-Pulse
companions:
  - requirements.md
  - trust-model.md
  - constants.md
  - test-matrix.md
  - ../../planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md
sources:
  - ../../planning-artifacts/prds/prd-Fleet-Pulse-2026-08-18/prd.md
  - ../../planning-artifacts/prds/prd-Fleet-Pulse-2026-08-18/addendum.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# FleetPulse — a fleet dashboard a dispatcher can trust

## Why

**A pain to solve, on a deadline.** Dispatchers already have a dashboard with plenty of data on it; what they do not have is grounds to believe it. Three incidents define the product: two trucks dispatched to the same address because nothing coordinated two dispatchers acting on one fleet; a driver out of fuel while the screen read 80%, because a sensor glitch was rendered verbatim; a route reassigned over another dispatcher's change, with nobody able to say who did what. The telemetry sources are known-unreliable by design — GPS arrives in out-of-order bursts after signal loss, the fuel sensor reads a false 0% under hard braking, truck #7's speed sensor sticks at 999 km/h, and the fleet API fails intermittently under load. A dashboard that renders that stream verbatim is worse than no dashboard: it manufactures confidently wrong decisions. **The north star is trust, not polish** — every trade-off in this contract resolves toward data trustworthiness over visual finish. The work is also an assignment submission due 2026-08-19, evaluated on spec-driven development, architecture, security, performance, observability, and test quality; the graded artifact is the whole repository, not just the running app.

## Capabilities

- **CAP-1 — Self-built mock server**
  - **intent:** The repository ships a mock server implementing the brief's client-facing contract and all eight intentional failure modes, so every downstream slice has a faithful, deterministic substrate to build and test against.
  - **success:** `npm start` runs it; one contract test asserts every server emission parses against the client's wire-type declarations; each of the eight failure modes can be fired deterministically on demand and is exercised by a test.

- **CAP-2 — Live fleet overview**
  - **intent:** A dispatcher sees all 12 trucks positioned live, with status and data freshness legible at a glance.
  - **success:** All 12 markers update against the running stream; a 30-reading GPS batch moves the marker to the newest-by-timestamp position and draws one sorted trail — never separate markers, never a visible stall; a truck silent past the staleness threshold carries an age badge. (FR-1–FR-4)

- **CAP-3 — Telemetry integrity engine**
  - **intent:** Every inbound reading is ordered and validated before it can affect anything a dispatcher sees, and every displayed value carries an explicit trust state.
  - **success:** Framework-free tests prove an older reading backfills history but never overwrites current state; 999 km/h is masked as sensor fault while 120–200 km/h alerts immediately; all four fuel-0% branches resolve per policy; every rejection lands in the bounded anomaly log. (FR-5–FR-9; [trust-model.md](trust-model.md))

- **CAP-4 — Route lifecycle management**
  - **intent:** A dispatcher can create, transition, reassign, and cancel routes, with every mutation attributed and every destructive or ambiguous action confirmed first.
  - **success:** Only legal transitions are offered; reassign and cancel require confirmation; creating a route for a truck that already has an active one — or one in `maintenance` — warns and requires explicit confirmation; the audit trail names who changed what and when. (FR-10, FR-11, FR-14, FR-15, FR-34)

- **CAP-5 — Concurrent-safe mutations with named conflict resolution**
  - **intent:** Two dispatchers acting on the same route never silently overwrite each other; when they collide, the loser sees who collided with them and decides what happens next.
  - **success:** Two-tab test — a stale-version 409 and a mid-processing race 409 both land in one side-by-side chooser naming the conflicting dispatcher and showing intended change vs. current server state; re-applying resubmits against the fresh version; an open editor shows an inline notice when the route moves underneath it, before any save is attempted. (FR-12, FR-13, FR-31)

- **CAP-6 — Dispatcher presence**
  - **intent:** Dispatchers register by name, see who else is on the fleet, and see which truck each of them is looking at.
  - **success:** Presence is keyed by server-issued identity, so two same-named dispatchers are two entries; a late, duplicate, or out-of-order disconnect is a safe no-op; the liveness timeout removes a silently vanished dispatcher; a late disconnect never removes a re-registered one. (FR-16–FR-19)

- **CAP-7 — Vehicle detail panel**
  - **intent:** Selecting a truck opens its live signals, recent history, assigned route, and a way to alert it — with the same trust annotations that appear on the overview.
  - **success:** Speed, fuel, temperature, and mileage render with their per-signal trust state carried through; charts draw over the bounded history window; an alert sent to a truck is visible to every dispatcher, not just the sender. (FR-20–FR-23, FR-32)

- **CAP-8 — Resilience and explicit degraded mode**
  - **intent:** When the stream or the fleet API fails, the dashboard keeps working on cached data and says by name what is degraded, rather than presenting old data as fresh.
  - **success:** A 503 is retried per `Retry-After`; three consecutive 503s open the circuit and raise a banner naming the failing condition, clearing only after a healthy hysteresis period; sockets reconnect with backoff and presence rebuilds; a throwing widget does not take the dashboard down; a fleet reset wipes derived state and refetches. (FR-24–FR-28, FR-33)

- **CAP-9 — Observability, both audiences**
  - **intent:** Dispatchers get an aggregated anomaly view that answers "real problem or sensor bug?"; developers get live stream and socket health.
  - **success:** The anomaly view lists detected anomalies with truck, type, and timestamps from the bounded log; the developer panel reports SSE events/sec, WebSocket ping/pong latency, dropped events, and reconnection counts — outside the dispatcher workflow. (FR-29, FR-30)

- **CAP-10 — End-to-end traceability**
  - **intent:** Every requirement traces to its implementation and test, and every decision traces back to the requirement it serves — the submission is evaluated on this, not only on running code.
  - **success:** Commits and `DECISIONS.md` entries reference FR/NFR ids; test names cite their FR; README traces the data flow and walks the tire-pressure extensibility example; `PROMPTS.md` is maintained throughout, not reconstructed at the end. (G5, NFR-9)

## Constraints

- **The brief owns the wire contract.** The server is self-built, but its client-facing REST endpoints, WebSocket message set, SSE stream, and eight failure modes follow the assignment exactly — implemented faithfully rather than extended. Deterministic quirk triggers exist only under `/api/dev/*`, and client `src/` never references them (grep-enforceable).
- **The architecture spine's 18 invariants (AD-1–AD-18) are binding**, not advisory — dependency direction, pipeline stage order, the single batched commit, the single mutation gate, the two connection owners, and the rest. See [ARCHITECTURE-SPINE.md](../../planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md).
- **One constants module rules both sides.** Server emission parameters and client thresholds live in `shared/constants.js` and nowhere else; tests import them rather than restating them. A tunable literal elsewhere is a defect. ([constants.md](constants.md))
- **Trust is assigned in the pipeline, never in a widget.** Values cross the boundary as trust-carrying envelopes; one store selector layers stale and degraded on top; every widget reads that one source, so a value is always in exactly one of the five states. ([trust-model.md](trust-model.md))
- **Uncertainty fails toward alerting, never suppression (CM1).** Binding on every classifier, including ones registered later. A masked real emergency is a worse failure than a false alert, and this is tested explicitly.
- **Trust annotations are inline, not modal (CM2).** Suspect data is flagged where the value is; degraded state is one banner with hysteresis so it cannot flap.
- **No anonymous or unversioned writes.** Every mutation carries `X-Dispatcher-Id`; every version-bearing route mutation carries `If-Match`; all of it flows through the one API client — no component calls `fetch` directly. While the dispatcher is unregistered, mutations are refused with a visible reason.
- **The UI is pessimistic.** On-screen state changes only after server confirmation; a failed mutation leaves local state untouched and surfaces visibly.
- **Every in-memory collection is bounded** through one shared bounded-buffer utility — telemetry history, anomaly log, audit trail, obs counters. An uncapped collection is a review defect.
- **Server-originated text is untrusted display content** — rendered as text nodes only; `dangerouslySetInnerHTML` is banned repo-wide.
- **Extensibility is registration, not modification** (NFR-9): a new signal, anomaly rule, or widget is a new module plus one registration call. Editing an existing module to accommodate it is a violation.
- **Fixed stack, no additions.** React + TypeScript + Vite + Zustand + Vitest on the client; Express + `ws` only on the server; hand-rolled SVG for the grid and charts — no map library, no chart library, no CSS framework.
- **Depth over breadth (CM3).** A tier starts only when the previous one is done and green; the server comes first, the integrity pipeline second, with its tests written alongside. FR-13's side-by-side conflict chooser is the brief's flagged senior-level challenge and is not cuttable.
- **Deadline 2026-08-19**, local-only: `npm install && npm start`, `npm test`, latest Chrome. The submission is a Git repository from the first build step.

## Non-goals

- **Extending the brief's protocol.** Route-level "who is editing this route" presence is out — the protocol broadcasts truck-level viewing only, and that is the honest proxy, documented as a limit rather than engineered around.
- **Authentication and real user accounts.** Dispatcher identity is a registration, not a login.
- **Persistence beyond the session.** No database, no storage; a route audit trail is session-scoped and a late joiner sees a partial one.
- **Browsers beyond latest Chrome**, and any deploy, CI, or soak-testing infrastructure — the submission runs on the evaluator's machine.
- **Visual polish beyond legibility.** Map fidelity and chart beauty are ungraded; we are building trust, not beauty.
- **A standalone anomaly-detection dashboard.** FR-29 already delivers its value.
- **Tier-3 stretch features** — filterable view, keyboard shortcuts, geofencing — unless tiers 1 and 2 are done and green.

## Success signal

A reviewer clones the repo, runs `npm install && npm start`, and opens two browser tabs. Truck #7 never shows 999 km/h and no truck ever silently drops to 0% fuel — both appear as annotated, logged anomalies while a genuine overspeed or a genuine empty tank alerts immediately. Conflicting route edits from the two tabs produce a conflict chooser naming the other dispatcher and showing both versions, not a silent overwrite. Killing the server raises a banner that names what is degraded instead of leaving stale numbers looking fresh. `npm test` runs sixteen or more meaningful cases across the six mandated areas, each named for the requirement it proves. The reviewer closes the repo thinking: this was designed for real faults, and I can trace every requirement to its implementation and its test.

## Assumptions

- **The tunable constants are authored, not observed.** Because the mock server is self-built, thresholds and emission parameters are deliberate defaults fixed together in one module — defensible in review, adjustable in one place — rather than values measured against a provided server.
- **Hand-rolled SVG is sufficient** for the fleet grid and the detail charts (resolves the map-library question): deterministic, dependency-free, offline-safe for the defense demo, and map quality is ungraded.
- **Clock skew is negligible** against the localhost mock; the reading-timestamp/arrival-clock split is stated as a production caveat rather than compensated for.
- **A reconnect issues a fresh dispatcher identity**, so one person's audit entries may span two identities mid-shift. Accepted and documented rather than solved.
- **Detail-panel history backfill is a build-time choice** — either way, fetched readings enter through the same pipeline seam as live ones, so no second history path exists.
