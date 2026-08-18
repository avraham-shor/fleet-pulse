# FleetPulse PRD — Addendum

Technical depth and downstream-document material that supports the PRD but does not belong in it.
Consumers: architecture / solution design, DECISIONS.md, README.md (architecture overview section).

## Stack decision

**Chosen: React + TypeScript.**

Rationale:
- Assignment-recommended framework; evaluators are calibrated to it.
- Richest testing ecosystem for the graded test surface (Vitest/Jest + Testing Library) — the assignment requires ≥8 meaningful tests over the hard parts (anomaly detection, batch processing, out-of-order timestamps, optimistic locking, ghost presence).
- Component model maps naturally onto the plugin/widget architecture the assignment lists as a core topic.

Alternatives considered:
- **Angular + TS** — RxJS is a genuine advantage for SSE stream processing, but Angular is a weaker fit given the candidate's delivery speed under the assignment deadline.
- **Vanilla JS/TS** — demonstrates platform mastery but spends scarce hours on plumbing that the framework gives for free.

## Notes for architecture

- Telemetry pipeline must be decoupled from UI (explicit evaluation criterion: "Is your telemetry pipeline decoupled from the UI?").
- Server contract — **self-built** (interviewer-confirmed 2026-08-18; the PDF's "provided as a single file" wording is inoperative): we author `server.js` to the brief's spec — Express + `ws` only, HTTP :3000, WS at `/ws`, SSE at `GET /api/telemetry/stream`, 12 trucks, all eight intentional failure modes. It ships in the repo as part of the submission.
- The server is a design surface, and building it is the **first story** — everything downstream consumes it:
  - Quirk emission parameters (batch sizes, glitch windows, stuck-sensor cadence) are ours to choose and must stay consistent with the client thresholds in PRD §5 — define both sides from one constants source of truth (OQ-3).
  - 409 responses carry the conflicting dispatcher's identity and the current route state (FR-13) — a server design obligation now, not a hope.
  - `viewing_truck` accepts a null truck id = "viewing nothing," and the server broadcasts the clear (FR-18).
  - Dev-only deterministic quirk triggers (force failure mode N on demand) are worth designing in for tests and the defense-interview demo; they must stay contract-neutral — the graded client never depends on them (OQ-6).
- Optimistic locking transport: `If-Match` header with route version; mutations carry `X-Dispatcher-Id` header.
- Presence granularity constraint: client→server WS messages are limited by the assignment spec to `register_dispatcher` / `ping` / `viewing_truck`, and we implement that spec faithfully rather than extend it. Route-level "who is editing this route" presence is therefore out; truck-level viewing is the proxy (UJ-1 step 1 documents this honestly).
- FR-31 (inline pre-save change notice) costs no new transport: the server already broadcasts `route_updated` / `route_reassigned` to all clients; the editor component just subscribes and renders the notice.
