# Epic 1 Context: Fleet-Pulse: Full Build

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic delivers FleetPulse end to end: a self-built mock fleet-dispatch server plus a React/TypeScript client giving a dispatcher a real-time picture of a 12-truck fleet they can actually trust. It exists because the incidents motivating this product — a duplicate dispatch, a sensor lie rendered as fact, a route silently overwritten by another dispatcher — are failures of trust and coordination, not data volume. The build is one sequential backlog: the mock server and its eight failure modes, the wire contract and transport layer, a telemetry integrity pipeline that orders and classifies every reading before display, the fleet overview, dispatcher presence, route lifecycle with concurrency-safe conflict resolution, the vehicle detail panel, resilience/degraded-mode handling, and observability plus submission traceability. This is an interview-assignment submission due 2026-08-19, evaluated on spec-driven development, architecture, security, performance, observability, and test quality — the whole repository is graded, not just the running app.

## Stories

- Story 1.1: Repo scaffold and the shared constants module
- Story 1.2: server.js complete — contract and all eight failure modes
- Story 1.3: Wire contract types and the transport layer
- Story 1.4: Store foundation and the telemetry integrity engine
- Story 1.5: Live fleet overview
- Story 1.6: Dispatcher presence
- Story 1.7: Route lifecycle management
- Story 1.8: Conflict avoidance and resolution
- Story 1.9: Vehicle detail panel, resilience, and degraded mode
- Story 1.10: Observability and submission traceability

## Requirements & Constraints

- A displayed value is always in exactly one of five trust states — trusted, suspect, sensor fault, stale, degraded. Plausibility trust (trusted/suspect/sensor-fault) is assigned in the pipeline only; staleness (arrival clock) and degraded (system health) are layered on top by one selector.
- Two clocks must never be conflated: reading timestamp drives ordering, backfill, and suspect windows; arrival clock drives staleness only.
- Uncertainty always fails toward alerting, never suppression (CM1), binding on every classifier including ones added later. Trust annotations stay inline, never modal, and the degraded banner uses hysteresis so it cannot flap (CM2).
- Depth over breadth (CM3): tiers are strictly sequential, each done and green before the next starts — Tier 1 core (full mandated feature set, including the FR-13 conflict chooser, not cuttable), then Tier 2 (circuit breaker, dev observability panel), then Tier 3 stretch (filterable view, shortcuts, geofencing) only if time remains.
- Every mutation carries the acting dispatcher's identity and, for routes, a version check; a stale write is rejected, never silently applied. The UI is pessimistic — on-screen state changes only after server confirmation, and a failed mutation leaves local state untouched and visibly errors.
- Destructive or ambiguous actions (cancel, reassign, creating a route for an already-busy truck) require explicit confirmation; all input is validated before submission.
- Every in-memory collection (telemetry history, anomaly log, audit trail, obs counters) must be bounded — an uncapped collection is a review defect. Server-originated text is untrusted display content, rendered as text nodes only.
- Extensibility is registration, not modification: a new signal, anomaly rule, or widget is a new module plus one registration call.
- Test target is 16+ meaningful cases (minimum 8 mandated) spanning GPS batching, out-of-order timestamps, fuel and speed classification, optimistic-locking conflicts, ghost presence, circuit breaker, and the busy-truck guard; constants are imported into tests, never re-hardcoded, and test names cite the FR they prove.
- Deadline 2026-08-19, local-only (`npm install && npm start`, `npm test`, latest Chrome); no deploy, persistence beyond the session, CI, or authentication beyond dispatcher registration.

## Technical Decisions

- Paradigm: layered unidirectional dataflow — `transport/` → `pipeline/` → `store/` ← `ui/` — with the telemetry integrity engine as a pipes-and-filters core; `pipeline/` and `store/` import no React and no DOM.
- One `shared/constants.js` module holds every tunable on both sides (server emission parameters and client thresholds, chosen together); a tunable literal anywhere else is a defect.
- Wire shapes are declared once, verbatim from the assignment brief, in `src/contract/`. `server.js` is a single in-memory Node file importing only express, ws, node builtins, and constants; one contract test asserts every server emission parses against those declarations.
- Exactly two connection owners: one SSE manager, one WS manager, both handling reconnect/backoff (1s doubling to a 15s cap); WS re-registers and rebuilds presence on reconnect.
- One mutation gate: `transport/api-client` is the only caller of `fetch`, injects the dispatcher-id and version headers, normalizes every failure to one discriminated union (conflict/retryable/error), and routes every 409 into a single conflict flow. Route state has exactly one writer — the WS broadcast echo, not the mutation's own success response — applied monotonically by version.
- Single Zustand store with a single coalescing batched commit; no component-local mirrors of fleet/route/presence state.
- Fixed pipeline stage order: ingest → order/dedupe by reading timestamp → classify → one batched commit; backfilled (out-of-order) readings still pass classification so history entries carry real trust.
- Every collection is created through one shared bounded-buffer utility, capped from constants. No map or chart library — hand-rolled SVG for the coordinate grid, trails, and detail sparklines.
- The dispatcher's own identity is session state, not a presence entry, and survives a fleet reset; presence itself is keyed only by server-issued id, never by name.
- Fixed stack, no additions: Node 24 LTS, TypeScript ~6.0.2, React 19.2.8, Vite 8.2.1, Zustand 5.0.15, Vitest 4.1.10, Testing Library 16.3.2, Express 5.2.1, `ws` 8.21.3.

## UX & Interaction Patterns

- All five trust states render through one shared badge component and token set — no widget invents its own trust visuals.
- Conflict handling is two-stage: an inline, non-blocking notice appears under an open editor the moment another dispatcher's change lands, before any save is attempted (avoidance); an actual version conflict opens a side-by-side chooser naming the conflicting dispatcher with both versions, letting the dispatcher adopt, re-apply, or back out (resolution).
- Presence shows who else is active and which truck each dispatcher is currently viewing — truck-level only, not route-level, an honest limit of the underlying protocol.
- Degraded mode is one global banner naming which condition is down (stream vs. fleet fetch), clearing only after a healthy hysteresis period so it never flaps; per-truck staleness badges are separate, driven by the trust selector.
- A failure inside one widget is contained by its own error boundary; the rest of the dashboard keeps working.

## Cross-Story Dependencies

- Strict build order: server (1.2) → contract/transport (1.3) → store/pipeline (1.4) → UI stories (1.5 onward), each stage consuming the one before it.
- Presence (1.6) precedes route lifecycle (1.7): mutations are refused while the dispatcher is unregistered.
- Conflict avoidance and resolution (1.8) builds directly on route lifecycle (1.7), reusing its mutation gate and conflict path.
- Vehicle detail/resilience (1.9) depends on the trust engine (1.4) for per-signal annotations and on transport (1.3) for reconnection/circuit-breaker behavior.
- Observability (1.10) is gated behind the rest of the epic — its tier-2 portion starts only once the core feature set is green — and closes out README/DECISIONS/PROMPTS traceability for the whole epic.
