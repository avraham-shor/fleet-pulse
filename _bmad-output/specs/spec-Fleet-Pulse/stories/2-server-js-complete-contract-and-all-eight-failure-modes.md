---
title: 'server.js complete — contract and all eight failure modes'
type: 'feature'
created: '2026-08-18'
status: 'done'
route: 'plan-code-review'
review_loop_iteration: 0
baseline_commit: 'ef4058963e865bee56b35a4fb5677c592050129b'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/constants.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repo has no server yet. Every later story — transport, pipeline, every UI slice — needs a faithful, deterministic substrate implementing the brief's REST/WS/SSE contract and all eight intentional failure modes to build and test against.

**Approach:** Build `server.js` as one Node ESM file (Express + `ws` only) implementing the brief's ten REST endpoints, its full WebSocket message set, the SSE stream, a 12-truck 2s-tick simulator, and a quirk scheduler that self-fires all eight failure modes and can also be fired deterministically via `POST /api/dev/quirk/:id`. Declare the shapes `server.js` emits in `src/contract/` (TS types, brief-verbatim names) and add one contract test asserting every emission parses against them.

## Boundaries & Constraints

**Always:**
- All ten REST endpoints per the brief/AD-11: `GET /api/fleet` (15% chance 503 + `Retry-After`), `GET /api/fleet/:truckId`, `GET /api/routes`, `POST /api/routes` (requires `X-Dispatcher-Id`), `PATCH /api/routes/:routeId` (`If-Match`), `PUT /api/routes/:routeId/reassign`, `POST /api/fleet/:truckId/alert`, `GET /api/telemetry/stream` (SSE), `GET /api/telemetry/history/:truckId?limit=`, `POST /api/reset`.
- Full WS message set per AD-11: server→client `registered`, `dispatcher_joined`/`_left`/`_viewing`, `route_assigned`/`_updated`/`_reassigned`, `truck_alert`, `fleet_reset`, `pong`; client→server `register_dispatcher`, `ping`, `viewing_truck` (accepts a null truck id — broadcast the clear).
- AD-12 internal composition (sections, not files, in one file): truck simulator (2s tick) ← quirk scheduler (self-fires per `SERVER_PARAMS` probabilities; `/api/dev/quirk/:id` is an additive deterministic override, never the sole firing path); route store (per-route integer versions); presence registry; SSE broadcaster (reaps clients on write error); WS hub.
- Every 409 body carries the conflicting dispatcher's `id` + display name + the current route state (AD-11) — the conflict UI never needs a presence lookup.
- Quirk 8 (PATCH race) is a **real** reassignment by a permanently-registered synthetic `system` dispatcher, visible in the presence registry, broadcast normally — never a phantom id (AD-12).
- `POST /api/reset` wipes fleet/route simulation state only; the presence registry survives and re-announces via `dispatcher_joined` after `fleet_reset` broadcasts (AD-17).
- Deterministic quirk triggers exist only under `/api/dev/quirk/:id`; nothing under `src/` (excluding this story's own contract test) references `/api/dev/*` (grep-enforceable, AD-11).
- `src/contract/` declares **only** what `server.js` emits this story — SSE telemetry envelope, the server→client WS message set, REST response/error bodies incl. the 409 shape — as TS types, brief-verbatim field names. Story 1.3 adds client→server shapes and the transport layer on the same directory; do not build `transport/` here.
- Every tunable (probabilities, timings, the port) lives in `shared/constants.js`, mirrored in `constants.md` (AD-2) — no literal elsewhere.
- `server.js` reads `PORT` from the environment, falling back to `SERVER_PARAMS.SERVER_PORT`; `vite.config.ts`'s dev-proxy target follows the same variable. Document `PORT` in a new `.env.example`.
- Add `server.js` to `tsconfig.node.json`'s `include` (its existing `types: ["node"]`, DOM-free lib already fits; no new tsconfig file).
- The contract test is framework-free (node env), hand-rolled shape assertions (explicit key sets + `typeof`/range checks) — no schema library (fixed stack, no additions). It is the "Contract fidelity" structural assertion in `test-matrix.md`, separate from the 16 mandated cases.

**Ask First:** If a wire-shape field name isn't fixed by the brief PDF, AD-11, or the Consistency Conventions naming table, do not invent it silently — HALT and confirm with the human before it's frozen into `contract/`.

**Never:** Modify the brief's contract to add/rename fields; build `src/transport/` or client→server contract types (story 1.3); add a schema-validation dependency; let a quirk's *only* firing path be the dev trigger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| GPS batch | Truck regains signal | One SSE dispatch of 10–30 buffered readings, real (possibly non-monotonic) timestamps | N/A |
| Fuel glitch | Hard-braking window fires | Fuel reads 0% for `FUEL_FALSE_ZERO_GLITCH_MIN/MAX_MS`, then recovers | N/A |
| Stuck speed | Quirk fires on `truck_7` | 999 km/h emitted for `STUCK_SPEED_DURATION_MIN/MAX_MS`, then recovers | N/A |
| Route conflict (stale version) | `PATCH` with stale `If-Match` | 409, body carries conflicting dispatcher id+name + current route | Never a silent overwrite |
| Out-of-order SSE | Free-parameter quirk fires | A tick emits with an older timestamp than the truck's previous emission | N/A |
| Ghost presence | WS closes, 20% chance | `dispatcher_left` delayed `GHOST_DISCONNECT_DELAY_MS` | Late/duplicate leave is a no-op elsewhere (client-side, not this story) |
| Fleet 503 | `GET /api/fleet`, 15% chance | 503 + `Retry-After: FLEET_503_RETRY_AFTER_S` | N/A |
| PATCH race | Route reassigned mid-processing | 409 via same shape/path as stale-version conflict | Quirk 8 uses the real `system` dispatcher |
| Dev quirk trigger | `POST /api/dev/quirk/:id` | Fires the named quirk deterministically now, in addition to its own probability | Unknown `:id` → 404 |
| Unregistered mutation | `POST /api/routes` missing `X-Dispatcher-Id` | 400 | Never processed anonymously |

</frozen-after-approval>

## Code Map

- `shared/constants.js` -- `SERVER_PARAMS` already has 7 of 8 quirks' timings/probabilities + `SERVER_PORT`; add `OUT_OF_ORDER_CHANCE` / `OUT_OF_ORDER_MAX_SKEW_MS` (free parameters, AD-2) and mirror into `constants.md`
- `vite.config.ts:9-19` -- proxy already imports `SERVER_PARAMS.SERVER_PORT`; make it prefer `process.env.PORT`
- `tsconfig.node.json:25` -- `include` array; add `"server.js"` (closes the story-1.1 tsconfig deferral)
- `ARCHITECTURE-SPINE.md` AD-11, AD-12, AD-16, AD-17 -- binding endpoint/WS/quirk/reset rules this file must satisfy exactly
- `requirements.md` -- Failure-mode coverage table + FR-3, FR-6, FR-7, FR-8, FR-12, FR-13, FR-16-19, FR-24-26, FR-31-34 -- behavioral acceptance detail
- `_bmad-output/implementation-artifacts/deferred-work.md` -- two entries this story closes (port override, `server.js` tsconfig coverage); update on completion

## Tasks & Acceptance

**Execution:**
- [x] `shared/constants.js`, `constants.md` -- add out-of-order + confirm `SERVER_PORT`/`PORT` pairing -- AD-2
- [x] `src/contract/telemetry.ts`, `src/contract/ws-server.ts`, `src/contract/rest.ts` -- declare server-emitted wire shapes verbatim -- AD-13 (partial, this story's half)
- [x] `server.js` -- full REST/WS/SSE/simulator/quirk-scheduler implementation per AD-11/AD-12 -- CAP-1
- [x] `server.contract.test.js` (or colocated under `src/contract/`) -- hand-rolled assertions that every emission matches `contract/` -- CAP-1 success criterion
- [x] `vite.config.ts` -- proxy target reads `PORT` -- closes story-1.1 deferral
- [x] `tsconfig.node.json` -- include `server.js` -- closes story-1.1 deferral
- [x] `.env.example` -- document `PORT` -- closes story-1.1 deferral
- [x] `DECISIONS.md`, `_bmad-output/implementation-artifacts/deferred-work.md` -- record `PORT` choice, contract/-split decision, close the two deferred items

**Acceptance Criteria:**
- Given `npm start`, when the server boots, then all ten REST endpoints, `/ws`, and the SSE stream respond per AD-11.
- Given the quirk scheduler runs unattended, when enough time passes, then all eight failure modes each fire at least once at their configured odds/timing.
- Given `POST /api/dev/quirk/:id` with a valid id, when called, then that quirk fires immediately in addition to its own probability path.
- Given a `PATCH` with a stale `If-Match` or a mid-processing reassignment race, when the conflict is detected, then the 409 body carries the conflicting dispatcher's id, display name, and current route state.
- Given `PORT=4000` is set, when `npm start` runs, then both `server.js` and the Vite dev proxy target `:4000`.
- Given `npm test`, when it runs, then the new contract test asserts every server emission parses against `src/contract/` and passes alongside the existing suite.

## Design Notes

**Out-of-order quirk (free parameter, AD-2):** the brief fixes no probability for quirk #5. Chosen: `OUT_OF_ORDER_CHANCE` low (~10%), `OUT_OF_ORDER_MAX_SKEW_MS` a few ticks (~3s) — old enough to exercise FR-6 backfill, not so old it desyncs the trail. Document rationale in `constants.md` alongside the other server params.

**Contract test shape:** mirror `shared/constants.test.js`'s pattern from story 1.1 — explicit expected-key-set + `typeof`/range assertions per message/endpoint shape, not a schema library. Drive it by actually invoking `server.js`'s handlers/emitters (supertest-free: use Node's `http`/`EventSource`-equivalent or direct function calls into the simulator/handlers) rather than spinning a real network server, unless a real listen is simpler here — implementer's call, framework-free either way.

## Verification

**Commands:**
- `npm test` -- expected: full suite green, including the new contract test
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` typechecks `server.js` (node project) and `src/contract/` (app project) clean

**Manual checks (if no CLI):**
- `npm start`, then hit `GET /api/fleet` and `GET /api/telemetry/stream` (curl/Invoke-RestMethod/browser) and confirm live SSE ticks every 2s for 12 trucks
- `POST /api/dev/quirk/3` and confirm `truck_7` emits 999 km/h on the next tick(s)
- Open two terminals' WS clients (or browser devtools), register two dispatchers, and confirm `dispatcher_joined`/`registered` broadcast correctly

## Suggested Review Order

**Entry point — the contract**

- Wire shapes `server.js` commits to emit, verbatim from the brief's naming.
  [`rest.ts:1`](../../../../src/contract/rest.ts#L1)

- Server→client WS message set and the SSE telemetry envelope.
  [`ws-server.ts:1`](../../../../src/contract/ws-server.ts#L1)
  [`telemetry.ts:1`](../../../../src/contract/telemetry.ts#L1)

**Server core**

- Single-file composition root: REST/WS/SSE mounted on one process (AD-12).
  [`server.js:1100`](../../../../server.js#L1100)

- Per-instance state factory — closure, not module scope (fixed after review).
  [`server.js:421`](../../../../server.js#L421)

- 2s-tick simulator driving all eight quirks' self-fire probabilities.
  [`server.js:589`](../../../../server.js#L589)

- Deterministic dev triggers, quarantined under one route (AD-11).
  [`server.js:661`](../../../../server.js#L661)
  [`server.js:1027`](../../../../server.js#L1027)

- Optimistic-locking gate shared by PATCH and reassign (FR-12/13).
  [`server.js:566`](../../../../server.js#L566)

**Concurrency & security hardening (review round)**

- Live-state update picks the batch's true-newest reading, not array/iteration order.
  [`server.js:495`](../../../../server.js#L495)

- Intra-batch timestamp swap excludes the one real-values index it must never touch.
  [`server.js:375`](../../../../server.js#L375)

- `POST /api/reset` racing an in-flight mutation now 404s instead of committing a phantom route.
  [`server.js:574`](../../../../server.js#L574)

- Reserved system identity can no longer be impersonated by a bare REST call.
  [`server.js:706`](../../../../server.js#L706)

- Re-registering on the same socket retires the old identity instead of leaking it.
  [`server.js:721`](../../../../server.js#L721)

- Every non-2xx response — including parse failures and unmatched routes — stays `ApiErrorBody`-shaped.
  [`server.js:1040`](../../../../server.js#L1040)
  [`server.js:1056`](../../../../server.js#L1056)

- A client socket error no longer risks taking the whole server down.
  [`server.js:829`](../../../../server.js#L829)

- Ghost-disconnect timers are tracked and cancelled on shutdown, not left dangling.
  [`server.js:1077`](../../../../server.js#L1077)

**Contract test**

- Drives a real ephemeral-port instance over real HTTP/WS/SSE — no internal calls, no schema library.
  [`server.contract.test.js:230`](../../../../server.contract.test.js#L230)

- The quirk-5 out-of-order case now asserts the live snapshot never regresses, not just history.
  [`server.contract.test.js:616`](../../../../server.contract.test.js#L616)

- Unattended self-fire, stubbing `Math.random` to prove the real probability gates work, not only the dev-trigger bypass.
  [`server.contract.test.js:655`](../../../../server.contract.test.js#L655)

**Config & wiring**

- `server.js` and the Vite dev proxy read the same `PORT` fallback, closing a story-1.1 deferral.
  [`server.js:1130`](../../../../server.js#L1130)
  [`vite.config.ts:9`](../../../../vite.config.ts#L9)

- `server.js` now sits inside a TS project for the first time.
  [`tsconfig.node.json:1`](../../../../tsconfig.node.json#L1)

**Traceability**

- Story 1.2's decisions, the code-review pass, and every finding's disposition.
  [`DECISIONS.md:1`](../../../../DECISIONS.md#L1)

- Three real-but-out-of-scope findings deferred to later route/conflict stories.
  [`deferred-work.md:1`](../../../implementation-artifacts/deferred-work.md#L1)
