---
title: 'Wire contract types and the transport layer'
type: 'feature'
created: '2026-08-18'
status: 'done'
route: 'plan-code-review'
review_loop_iteration: 0
baseline_commit: '1fc4379cfcaf1c0bad8045a97d923b274663bf8d'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/constants.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The client has no way to talk to the server yet — no typed client→server wire shapes, and no owner for connections, reconnection, or mutation requests. Every later store/UI story needs one trustworthy transport boundary to build on.

**Approach:** Declare the client→server half of AD-13's contract (WS client messages + REST request bodies/headers), then build the two connection owners (`sse-manager`, `ws-manager`) and the single mutation gate (`api-client`, with its breaker) that everything above transport must go through.

## Boundaries & Constraints

**Always:**
- `src/contract/ws-client.ts` (new) declares `RegisterDispatcherMessage {type:'register_dispatcher', name?: string}`, `PingMessage {type:'ping'}`, `ViewingTruckMessage {type:'viewing_truck', truckId: string | null}`, and a `ClientWsMessage` union — brief-verbatim `type` values, camelCase fields, matching `server.js`'s actual parsing (`server.js:720-785`).
- `rest.ts` gains request-body types for `POST /api/routes` (`{truckId, destination}`), `PATCH /api/routes/:routeId` (`{status}`), `PUT /api/routes/:routeId/reassign` (`{truckId}`), `POST /api/fleet/:truckId/alert` (`{message}`) — reuse existing `Truck`/`Route`/`RouteActor`/`ApiErrorBody`/`ConflictErrorBody`/`FleetUnavailableErrorBody`/`ResetAckBody`; never redeclare them.
- `src/transport/api-client.ts` (AD-7) is the only caller of `fetch` for mutations: injects `X-Dispatcher-Id` on every mutation, `If-Match` only on PATCH/reassign (echoing `Route.version`), reads `dispatcherId` live from ws-manager's session field, refuses locally with a visible reason when unregistered (FR-16), and normalizes every failure to one discriminated union — `{kind:'conflict', body: ConflictErrorBody}` | `{kind:'retryable', retryAfterSeconds: number}` | `{kind:'error', body: ApiErrorBody}` — nothing above transport sees a raw `Response` or thrown fetch error.
- `api-client` owns a circuit breaker (FR-25): opens after `BREAKER_FAILURE_THRESHOLD` consecutive 503s from `GET /api/fleet`, probes at `max(BREAKER_PROBE_INTERVAL_MS, Retry-After-seconds)`, closes on a successful probe; `Retry-After` is read from the response header, never parsed from JSON.
- `sse-manager.ts` and `ws-manager.ts` (AD-8) are the only two places that open a connection, retry, or interpret WS/SSE messages. Both reconnect with backoff from `RECONNECT_BACKOFF_INITIAL_MS`, doubling by `RECONNECT_BACKOFF_MULTIPLIER`, capped at `RECONNECT_BACKOFF_MAX_MS` — managed manually (close + recreate), not relying on `EventSource`'s built-in retry.
- `ws-manager` sends `ping` every `WS_KEEPALIVE_PING_MS`, consumes `pong`, re-sends `register_dispatcher` and signals a presence rebuild on every reconnect, writes the session-scoped `dispatcherId` field (AD-17) only on `registered` / clears it only on socket loss, and drops unknown WS message types safely (counted, not thrown).
- Since `store/` and `pipeline/` don't exist until story 4+, `ws-manager` exposes an injected `onMessage(msg: ServerWsMessage)` handler and a typed send-only facade (`sendViewing(truckId)`); `sse-manager` exposes an injected `onBatch(batch: TelemetryBatch)` handler. Real store/pipeline wiring happens where those modules land (stories 4, 6, 7, 8) — this story ships both managers fully connection-correct and independently testable via injected handlers.
- All requests use relative paths (`/api/...`, `/ws`) so Vite's dev proxy forwards them; manually smoke-test an SSE disconnect/reconnect through the proxy (spine's explicit instruction for this story).
- Zero new npm dependencies, zero new `shared/constants.js` entries — all six transport tunables already exist.

**Ask First:** None anticipated — every wire field name is already fixed by `server.js`'s actual parsing or the brief. If a field name is genuinely ambiguous, HALT and confirm before freezing it into `contract/`.

**Never:** Modify already-declared server→client contract exports (`telemetry.ts`, `ws-server.ts`, existing `rest.ts` types); implement pipeline ingest/trust logic, presence-slice liveness rules, or the `fleet_reset` reset sequence (later stories own these — transport only relays the event upward); add a WS/HTTP client library; call `fetch` or open a socket from anywhere outside `transport/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| WS reconnect | Socket drops, backoff elapses | Reconnects, re-sends `register_dispatcher`, signals presence rebuild | Backoff doubles to cap, retries indefinitely |
| SSE reconnect | `EventSource` errors | Manager recreates the connection with the same backoff curve | Same cap/doubling as WS |
| Unregistered mutation | `api-client` called with no live `dispatcherId` | Refused locally, visible reason returned, no request sent | Never sends a mutation with a missing/empty `X-Dispatcher-Id` |
| Stale PATCH / reassign | Server returns 409 | `api-client` returns `{kind:'conflict', body}` | Caller never retries automatically |
| Fleet 503 x3 | Three consecutive `GET /api/fleet` 503s | Breaker opens; further GETs short-circuit locally | Probe scheduled at `max(interval, Retry-After)` |
| Unknown WS type | Server sends an unrecognized `type` | Dropped, counted, no throw | `onMessage` never receives it |

</frozen-after-approval>

## Code Map

- `src/contract/rest.ts:1` -- add request-body types for the four mutating REST endpoints; reuse existing `Truck`/`Route`/`RouteActor`/`ApiErrorBody`/`ConflictErrorBody`/`FleetUnavailableErrorBody`/`ResetAckBody`
- `src/contract/telemetry.ts:1`, `src/contract/ws-server.ts:1` -- reuse as-is, no changes
- `src/contract/ws-client.ts` (new) -- `RegisterDispatcherMessage`/`PingMessage`/`ViewingTruckMessage` + `ClientWsMessage` union, this story's half of AD-13
- `server.js:720-785` -- WS message parsing this story's client messages must match exactly
- `server.js:567-572,697,845,868-869,907,940,965,1056-1062` -- `If-Match` gate, `X-Dispatcher-Id` check, `Retry-After` header, request bodies, `ApiErrorBody` error codes api-client must match
- `shared/constants.js:20-76` (`CLIENT_THRESHOLDS`) -- `RECONNECT_BACKOFF_INITIAL_MS`/`_MAX_MS`/`_MULTIPLIER`, `WS_KEEPALIVE_PING_MS`, `BREAKER_PROBE_INTERVAL_MS`, `BREAKER_FAILURE_THRESHOLD` -- all reused, none added
- `ARCHITECTURE-SPINE.md` AD-7, AD-8, AD-13, AD-1, AD-17 -- binding rules this file must satisfy exactly
- `vite.config.ts:9-19` -- dev proxy rules transport's relative paths must match
- `src/transport/sse-manager.ts`, `ws-manager.ts`, `api-client.ts` (new) -- this story's deliverables

## Tasks & Acceptance

**Execution:**
- [x] `src/contract/ws-client.ts` -- declare client→server WS message types + union -- AD-13
- [x] `src/contract/rest.ts` -- add REST request-body types -- AD-13
- [x] `src/transport/ws-manager.ts` -- connect/reconnect/backoff, register, keepalive ping/pong, session `dispatcherId` field, `onMessage`/`sendViewing` -- AD-8/AD-17
- [x] `src/transport/sse-manager.ts` -- connect/reconnect/backoff, parse + `onBatch` handoff -- AD-8
- [x] `src/transport/api-client.ts` -- mutation gate: headers, error-union normalization, circuit breaker -- AD-7
- [x] Co-located `*.test.ts` for the three transport modules -- cover reconnect/backoff, unregistered-mutation refusal, conflict/retryable/error mapping, breaker open/probe/close -- FR-16/24/25/27, NFR-4/5

**Acceptance Criteria:**
- Given the WS socket drops, when the backoff elapses, then `ws-manager` reconnects, re-sends `register_dispatcher`, and signals a presence rebuild.
- Given no live `dispatcherId`, when a mutation is attempted through `api-client`, then it is refused locally with a visible reason and no request is sent.
- Given three consecutive 503s from `GET /api/fleet`, when a fourth call is attempted, then it short-circuits locally until the breaker's probe succeeds.
- Given a 409 response on PATCH or reassign, when `api-client` receives it, then it returns the conflict variant carrying the body, never a raw error.
- Given `npm test`, when it runs, then all new transport/contract tests pass alongside the existing suite.

## Design Notes

**Handler injection, not direct store import:** AD-1's dataflow diagram has connection managers calling store slice actions directly, but `store/`/`pipeline/` don't exist until stories 4/6/7/8. Resolved by having `ws-manager`/`sse-manager` accept injected handlers (`onMessage`, `onBatch`) at construction instead of importing a not-yet-built module. This keeps both managers connection-correct and unit-testable now; each later story wires its own slice actions in as the handler, satisfying AD-1's intent once the callee exists — no temporary/throwaway code, just a natural construction seam.

**Manual reconnect over native `EventSource` retry:** the spec'd backoff curve (1s doubling to 15s) doesn't match `EventSource`'s native fixed-delay retry, so `sse-manager` closes and recreates the `EventSource` itself on error, mirroring `ws-manager`'s reconnect loop.

## Verification

**Commands:**
- `npm test` -- expected: full suite green, including new transport/contract tests
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` typechecks the new files clean

**Manual checks (if no CLI):**
- `npm start`, open the app, confirm the WS connects and registers (check `registered` in devtools network/WS frames)
- Kill and restart `npm run server` while the client is running; confirm both SSE and WS reconnect on their own within ~15s
- Call `api-client`'s mutation path with no dispatcher registered (e.g. via a temporary console call) and confirm it refuses locally without a network request

## Suggested Review Order

**Entry point — the client→server contract (AD-13, this story's half)**

- The three client→server WS messages, brief-verbatim `type` values.
  [`ws-client.ts:1`](../../../../src/contract/ws-client.ts#L1)

- REST request-body types for the four mutating endpoints, reusing every existing response type.
  [`rest.ts:103`](../../../../src/contract/rest.ts#L103)

**Mutation gate + circuit breaker (AD-7)**

- The only `fetch` caller for mutations: header injection, then the 409/503/error split.
  [`api-client.ts:242`](../../../../src/transport/api-client.ts#L242)

- Breaker-guarded fleet fetch: FR-24's auto-retry loop feeding FR-25's 3-strike threshold.
  [`api-client.ts:196`](../../../../src/transport/api-client.ts#L196)

- Review-round fix: a non-503 failure now resets the streak instead of just skipping it, so a stale count can't falsely open the breaker later.
  [`api-client.ts:230`](../../../../src/transport/api-client.ts#L230)

- Review-round fix: a genuinely missing `Retry-After` header now falls back correctly (`Number(null) === 0` was silently passing through as a real value).
  [`api-client.ts:108`](../../../../src/transport/api-client.ts#L108)

- Review-round addition: `forceNextProbe()` gives a future `fleet_reset` sequence a way to bypass the probe schedule.
  [`api-client.ts:167`](../../../../src/transport/api-client.ts#L167)

- Review-round fix: a 409 body is now shape-checked before being cast to `ConflictErrorBody`, matching `readErrorBody`'s existing rigor.
  [`api-client.ts:130`](../../../../src/transport/api-client.ts#L130)

**Connection lifecycle — the two owners (AD-8, AD-17)**

- `ws-manager`'s own identity handling: `dispatcherId` set only on `registered`, and ping/pong RTT captured for FR-30.
  [`ws-manager.ts:204`](../../../../src/transport/ws-manager.ts#L204)

- Manual reconnect/backoff loop, not native retry — mirrored by `sse-manager`.
  [`ws-manager.ts:222`](../../../../src/transport/ws-manager.ts#L222)
  [`sse-manager.ts:137`](../../../../src/transport/sse-manager.ts#L137)

- Review-round fix: a fresh `connect()` now restarts the backoff curve instead of inheriting a stale escalated value.
  [`ws-manager.ts:258`](../../../../src/transport/ws-manager.ts#L258)
  [`sse-manager.ts:166`](../../../../src/transport/sse-manager.ts#L166)

**Concurrency hardening — stale-connection guards**

- The `socket !== mySocket` / `source !== mySource` guards stopping a superseded connection's late event from corrupting live state — added during self-review, then given real regression coverage.
  [`ws-manager.ts:228`](../../../../src/transport/ws-manager.ts#L228)
  [`sse-manager.ts:144`](../../../../src/transport/sse-manager.ts#L144)

**Tests — review-round additions**

- Empirically-verified regression test for the stale-connection guards (reviewer proved it fails without the guard; this pins it).
  [`ws-manager.test.ts:283`](../../../../src/transport/ws-manager.test.ts#L283)
  [`sse-manager.test.ts:187`](../../../../src/transport/sse-manager.test.ts#L187)

- Breaker streak-reset and `forceNextProbe()` coverage.
  [`api-client.test.ts:298`](../../../../src/transport/api-client.test.ts#L298)
  [`api-client.test.ts:325`](../../../../src/transport/api-client.test.ts#L325)

- Malformed-409 and missing-`Retry-After` edge cases.
  [`api-client.test.ts:140`](../../../../src/transport/api-client.test.ts#L140)
  [`api-client.test.ts:162`](../../../../src/transport/api-client.test.ts#L162)
