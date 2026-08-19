---
title: 'Route lifecycle management'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 3
baseline_commit: '8ee26a3ab83a7ff40f9d5818a207bc5515d16639'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The server's route endpoints, wire types, and `api-client.ts` mutation gate are fully built but nothing on the client calls them — a dispatcher cannot create, transition, reassign, or cancel a route, and there is no audit trail of who changed what.

**Approach:** Build CAP-4 (FR-10, 11, 12-partial, 14, 15, 34): a `routesSlice` fed only by the WS echo (`route_assigned`/`_updated`/`_reassigned`) as sole writer, a `RoutesPanel` widget that calls the existing `api-client` mutation gate with confirmation on destructive actions and the FR-34 busy/maintenance warn-and-confirm, plus a session-scoped bounded audit trail.

## Boundaries & Constraints

**Always:**
- Route state has exactly one writer — the WS broadcast echo, never the mutation's own HTTP success response (AD-16); an echo whose `version` ≤ the currently stored version for that route is a silently-dropped no-op.
- Every mutation goes through the existing `api-client.ts` gate only (AD-7) — no direct `fetch`. It already implements `createRoute`/`updateRouteStatus`/`reassignRoute` with `X-Dispatcher-Id`/`If-Match` injection and conflict/retryable/error normalization; this story only calls them.
- UI offers only transitions legal from the route's current status — mirror server.js's `LEGAL_TRANSITIONS` (`assigned`→`in-progress`/`cancelled`, `in-progress`→`completed`/`cancelled`, terminal states offer none). There is no separate cancel endpoint — cancel is `updateRouteStatus(routeId, version, {status:'cancelled'})`.
- Reassign and cancel require explicit confirmation before submission (FR-14, NFR-6). Creating a route for a truck that already has an active route or is in `maintenance` requires a clear warning plus explicit confirmation before submission (FR-34) — purely client-side, since a POST has no version to check server-side.
- Pessimistic UI: on-screen state changes only after the matching WS echo lands, never on bare HTTP 2xx. A failed mutation leaves local state untouched and visibly errors. A 409 conflict surfaces as a plain visible error naming the conflicting dispatcher — the side-by-side chooser is story 8, not this one.
- Audit trail is a session-scoped bounded collection built via the existing `createBoundedBuffer` (mirror `obsSlice.ts`'s anomaly log), capped by a new `CLIENT_THRESHOLDS` constant, appended from the same echo handlers that write the slice.
- Route echoes are low-rate, direct-commit actions (like presence join/leave) — never routed through `createCoalescingCommitScheduler`.
- New widget at `src/ui/widgets/routes/`, one `registerWidget` call (AD-6).

**Ask First:** None anticipated.

**Never:** Build the 409 side-by-side conflict chooser or the FR-31 inline avoidance notice (story 8). Touch `FleetOverview.tsx` or `PresencePanel.tsx`. Add an npm dependency or a modal library — a minimal inline confirm affordance is sufficient. Add a server-side busy-truck guard — FR-34 is explicitly client-only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create for idle truck | truckId + destination, target truck idle, no active route | `createRoute` call; route appears only after `route_assigned` echo | FR-10 |
| Create for busy/maintenance truck | target truck has an active route or `status: maintenance` | Warn-and-confirm dialog before submit; submits only on confirm | FR-34 |
| Legal transition | e.g. `assigned`→`in-progress` | UI updates only after `route_updated` echo | N/A |
| Illegal transition | e.g. a `completed` route | Transition control does not offer it | Not reachable |
| Reassign | pick a different truck | Confirm dialog, then `reassignRoute`; both trucks/route update only after `route_reassigned` echo | FR-14 |
| Cancel | any non-terminal route | Confirm dialog, then `updateRouteStatus(..., {status:'cancelled'})` | FR-14 |
| Stale echo | echo `version` ≤ stored version | Silently dropped, no state change | AD-16 mandated test |
| Mutation while unregistered | no `dispatcherId` | `api-client` refuses locally; visible error; no request sent | FR-16 |
| 409 conflict | concurrent version mismatch | Visible error naming the conflicting dispatcher, no chooser | FR-12/13 |

</frozen-after-approval>

## Code Map

- `server.js:865-955` (route endpoints), `:393-404` (`LEGAL_TRANSITIONS`), `:566-585` (`withVersionCheck`), `:229-237` (`sendConflict`) -- reference only, no server changes.
- `src/contract/rest.ts:35-131` (`Route`, `RouteActor`, `ConflictErrorBody`, create/update/reassign request bodies) -- already declared, no contract changes.
- `src/contract/ws-server.ts:50-69,88-98` (`RouteAssignedMessage`/`_Updated`/`_Reassigned`, `ServerWsMessage` union) -- already declared, no contract changes.
- `src/transport/api-client.ts:47-80,242-288` (`ApiClient`, `mutate<T>`, `createRoute`/`updateRouteStatus`/`reassignRoute`) -- already built and unused; call directly for these three. **Iteration-2 correction:** `getRoutes()` must be *added* here too (see below) -- this file is not otherwise touched.
- `src/transport/api-client.ts:178-194` (`fetchFleetOnce`, the single-attempt-normalize-to-`TransportResult` shape `getFleet` wraps with breaker/retry logic) -- template for the new `getRoutes()`. **Review finding (bad_spec, iteration 2):** iteration 1's `hydrateRoutes()` task was implemented as a raw `fetch('/api/routes')` in `bootstrap.ts`, bypassing `api-client.ts` entirely -- verified in the diff and confirmed against `api-client.ts:1-9`'s own header comment ("nothing above transport/ touches `fetch`") and the precedent that `startInitialFleetFetch` already calls `apiClient.getFleet()` rather than fetching directly. The root cause was this Code Map's own prior wording ("no changes") combined with Design Notes saying to "mirror `startInitialFleetFetch`'s shape" without spelling out that this means *through api-client*, not a bare `fetch`. Add `getRoutes(): Promise<TransportResult<Route[]>>` to the `ApiClient` interface and its returned object: a single-attempt call mirroring `fetchFleetOnce`'s normalize-to-`TransportResult` logic (fetch, 503→`retryable`, non-ok→`error`, parse failure→`invalid_response`, success→`{ok: true, data: Route[]}`) -- but with **no breaker wrapping**: FR-25's circuit breaker is scoped to `GET /api/fleet` only (per this file's own header comment and `getFleet`'s doc comment), and `hydrateRoutes()` is already documented as best-effort, so a plain single attempt is correct and simpler than reusing `getFleet`'s breaker/auto-retry loop.
- `src/store/store.ts:24,32-38` (`FleetPulseStore` composition) -- fold in `RoutesSlice` as a direct-commit slice (no scheduler change).
- `src/store/slices/presenceSlice.ts:57-73,105-124` (direct-commit action pattern) -- template for the echo handlers.
- `src/store/boundedBuffer.ts:31-73`, `src/store/slices/obsSlice.ts:47-52` (`createBoundedBuffer` + cap-constant pattern) -- template for the audit trail.
- `src/store/slices/routesSlice.ts` (new) -- `RouteEntry` keyed by `routeId`; `applyRouteAssigned`/`_Updated`/`_Reassigned` (monotonic by version, AD-16); `auditTrail` via `createBoundedBuffer`; `selectRoutes`/`selectAuditTrail`.
- `src/app/bootstrap.ts:55-77` (`handlePresenceMessage` switch, currently ignores `route_*` types per its own comment) -- add `route_assigned`/`_updated`/`_reassigned` cases dispatching into `routesSlice` actions.
- `src/ui/widgets/routes/RoutesPanel.tsx` (new) -- create form (truck select + destination), route list with legal-transition controls, reassign/cancel with confirm, audit trail view; calls `api-client` directly; registers itself (AD-6).
- `shared/constants.js` -- new `CLIENT_THRESHOLDS.AUDIT_TRAIL_CAP` (mirror `ANOMALY_LOG_CAP` at `:48`).
- `server.js:840-844` (`GET /api/fleet`, the existing initial-roster-fetch endpoint) -- pattern to mirror; reference only, no server changes.
- `server.js:861-863` (`GET /api/routes`) -- returns every current route (`[...state.routes.values()].map(toPublicRoute)`); already built, unused by any client code. **Review finding (bad_spec, iteration 1):** the WS protocol never replays route state on register/reconnect — confirmed only presence is replayed (`server.js:742-752`, `handleRegister`) — so this REST endpoint is the *only* way a client ever learns about a route that existed before its current connection. `routesSlice` starting empty and waiting only for live echoes means FR-34's warn-and-confirm silently fails to fire for any truck whose active route predates the session or a reconnect.
- `src/app/bootstrap.ts:33-50` (`startInitialFleetFetch`), `src/app/bootstrap.ts`'s `onConnect: () => { store.getState().resetPresence(); ... }` wiring -- template for `hydrateRoutes()`: call the new `apiClient.getRoutes()` (above) **only from `wsManager`'s `onConnect` callback**, alongside the existing `resetPresence()` call -- exactly one call site, mirroring `resetPresence()`'s own single call site. **Review finding (bad_spec, iteration 3):** iterations 1-2 called `hydrateRoutes()` from *two* places -- once explicitly right after `wsManager.connect()` in `createBootstrap()`, and again inside `onConnect` -- reasoning it covered "bootstrap" and "reconnect" separately. This double-fires on every single page load: `ws-manager.ts`'s own doc comment on `onConnect` (`:71-73`) states it is "fired once per successful connection (including the first)" -- confirmed by reading it directly -- so the explicit bootstrap-time call is entirely redundant with the one `onConnect` already provides on that same first connection. `resetPresence()` never needed a separate explicit bootstrap call for the identical reason and this story should not have added one either. Apply each returned route through the *same* monotonic-write action used for live echoes (`applyRouteAssigned` is safe to reuse for hydration too, since the guard is idempotent) -- this keeps AD-16's "WS echo is the sole writer" framing intact: hydration feeds the identical write path, it does not add a second writer. On a non-`ok` `TransportResult`, do nothing further (best-effort, per Design Notes) -- no error UI, no retry loop; the slice just catches up from the next live echo.
- `src/app/App.test.tsx:149-159` (story 1.6's `'AD-6: the presence widget mounts through the shell...'` test) -- template for a matching routes-widget mount test. **Review finding (verification-gap, iteration 3):** no test anywhere renders `<App />` through the real bootstrap/registry wiring and asserts `RoutesPanel` content is present -- `RoutesPanel.test.tsx` imports the component directly, bypassing `App.tsx`/`getWidgets()` entirely, so a dropped `import '../ui/widgets/routes/RoutesPanel.tsx'` line in `App.tsx` (or a missing `registerWidget` call) would silently ship with the full suite green. Add one case to `App.test.tsx` following the exact shape of story 1.6's own AD-6 test.

## Tasks & Acceptance

**Execution:**
- [x] `shared/constants.js` -- add `CLIENT_THRESHOLDS.AUDIT_TRAIL_CAP` -- audit trail bound (NFR-3, AD-10)
- [x] `src/store/slices/routesSlice.ts` (new) -- state, monotonic-by-version echo handlers, bounded audit trail, selectors -- FR-10/11/12/14/15, AD-16
- [x] `src/store/store.ts` -- fold in `RoutesSlice` as direct-commit -- AD-16
- [x] `src/app/bootstrap.ts` -- `route_assigned`/`_updated`/`_reassigned` cases -- AD-16
- [x] `src/transport/api-client.ts` -- add `getRoutes(): Promise<TransportResult<Route[]>>` to `ApiClient` (interface + implementation), a single-attempt `GET /api/routes` normalized the same way `fetchFleetOnce` normalizes `GET /api/fleet`, but with no breaker wrapping -- AD-7 (api-client is the sole `fetch` caller), review finding iteration 2
- [x] `src/app/bootstrap.ts` -- add `hydrateRoutes()`, called from **exactly one** place: inside `wsManager`'s `onConnect` callback, alongside `resetPresence()`. No separate call at the end of `createBootstrap()` -- `onConnect` already fires on the first connection (review finding, iteration 3). Applies each returned route via the existing monotonic-write action; does nothing further on a non-`ok` result (best-effort) -- closes the FR-34 hydration gap (review finding iteration 1); must go through `api-client.ts`, never a raw `fetch` (review finding iteration 2, AD-7)
- [x] `src/ui/widgets/routes/RoutesPanel.tsx` (new) -- create/transition/reassign/cancel controls, confirm-before-destructive, FR-34 warn-and-confirm, audit trail list, self-registers -- FR-10/11/14/15/34, AD-6/AD-7
- [x] `src/ui/widgets/routes/RoutesPanel.tsx` -- `ROUTE_LEGAL_TRANSITIONS[route.status] ?? []` defensive fallback so an unrecognized status can't throw during render -- review finding, iteration 1
- [x] `src/ui/widgets/routes/RoutesPanel.tsx` -- reset `reassignTarget` to `''` alongside the other confirm-state resets on a successful reassign, so a stale target can't silently resubmit a same-truck reassign -- review finding, iteration 1
- [x] `src/ui/widgets/routes/RoutesPanel.module.css` -- replace the two hardcoded colors in `.warning`/`.error`/`.buttonDanger` with this file's own `var(--token, fallback)` convention used everywhere else in it -- theme consistency, review finding iteration 1
- [x] `src/app/App.tsx` -- one side-effect import line for the new widget -- AD-6
- [x] `src/app/App.test.tsx` -- add one mount test proving `<App />` renders `RoutesPanel` content through the real bootstrap/registry wiring, mirroring the existing `'AD-6: the presence widget mounts through the shell...'` test (`:149-159`) -- closes the review finding, iteration 3
- [x] Co-located `*.test.ts`/`.test.tsx` covering the I/O matrix, especially monotonic-write no-op, unregistered-refusal, and conflict-visible-error, plus: a `getRoutes()` unit test in `api-client.test.ts` (mirroring `fetchFleetOnce`'s own coverage shape, minus breaker cases), a hydration test (bootstrap and reconnect each populate `routesSlice` from `apiClient.getRoutes()` before any echo arrives), a test for the `'retryable'` (503) branch of the mutation-failure display, and a test proving `hydrateRoutes()` is called exactly once on the first connection, not twice -- review findings, iterations 1, 2, and 3

**Acceptance Criteria:**
- Given a route lifecycle echo arrives over WS, when its version is ≤ the currently stored version for that route, then the update is silently dropped (AD-16 mandated test).
- Given the app starts, or the WS reconnects, while a route already exists on the server, when `RoutesPanel` reads that truck's assignment state, then it reflects the pre-existing route immediately — without waiting for a new lifecycle event — so FR-34's warn-and-confirm fires correctly for it (closes the review finding, iteration 1).
- Given any REST call this story makes, when it is made, then it goes through `transport/api-client.ts` — no `fetch` call anywhere under `src/app/` or `src/ui/` (AD-7, closes the review finding, iteration 2).
- Given the app's very first WS connection opens, when `hydrateRoutes()` runs, then `apiClient.getRoutes()` is called exactly once, not twice (closes the review finding, iteration 3).
- Given `<App />` renders through its real composition root, when the widget list mounts, then `RoutesPanel`'s content is present in the DOM (closes the review finding, iteration 3).
- Given `npm test`, when it runs, then the full suite (existing 208 + new) passes.
- Given `npm run lint` and `npm run build`, when run, then both are clean (`--max-warnings 0`; `tsc -b` + Vite build).

## Spec Change Log

- **Iteration 1 (bad_spec):** Triggering finding — three parallel review layers (blind-hunter, edge-case-hunter, verification-gap) independently surfaced that `routesSlice` had no path to learn about a route that existed before the client's current WS connection or a reconnect: `server.js` exposes `GET /api/routes` (`:861-863`) but nothing called it, and the WS protocol only replays *presence* on register (`server.js:742-752`), never routes. Verified directly in `server.js` before accepting the finding. **What was amended:** added a `hydrateRoutes()` task calling `GET /api/routes` at bootstrap and on every WS reconnect (Code Map, Tasks & Acceptance), reusing the existing monotonic-write action so AD-16's "WS echo is the sole writer" still holds — hydration feeds the same write path, it isn't a second writer. Also folded in four small patch-grade fixes surfaced by the same review pass (defensive fallback for an unrecognized `route.status`, resetting `reassignTarget` after a successful reassign, CSS token consistency, and a `'retryable'` failure-branch test) rather than looping back separately for each. **Known-bad state avoided:** FR-34's warn-and-confirm silently not firing for a truck whose active route predates the dispatcher's session or a reconnect — undermining the exact duplicate-dispatch risk the epic names as its motivating incident. **KEEP (verified correct, must survive re-derivation):** the monotonic-by-version write guard + audit-row append sharing one `applyRouteEcho`-style helper; the two-stage arm-then-confirm inline affordance for cancel/reassign/create (no modal dependency); FR-34's warn-and-confirm re-derived live from the store on every render of the create form; the single module-scope `routesApiClient` reading `dispatcherId` live through `getWsSendFacade()` on every call (never captured once); the additive, optional `WsSendFacade.getDispatcherId` extension in `ws-manager.ts` (backward-compatible — do not touch `PresencePanel.tsx` or its tests); pessimistic UI throughout (a mutation's 2xx only clears local in-flight/confirm state, never writes route data itself); the FR-tagged test-naming convention and full I/O-matrix coverage breadth achieved the first time through.

- **Iteration 2 (bad_spec):** Triggering finding — iteration 1's own re-derivation implemented `hydrateRoutes()` as a raw `fetch('/api/routes')` directly in `bootstrap.ts`, bypassing `api-client.ts` entirely (no `TransportResult` normalization, no consistency with the rest of the codebase's one-gate rule). Verified against `api-client.ts:1-9`'s own header comment ("nothing above transport/ touches `fetch`") and the existing precedent that `startInitialFleetFetch` already calls `apiClient.getFleet()` rather than fetching directly — confirmed by reading both files directly, not inferred. **Root cause:** this spec's own iteration-1 amendment told the implementer two contradictory things at once — Design Notes said to "mirror `startInitialFleetFetch`'s shape" (which does go through api-client) while the Code Map's api-client.ts entry still said "no changes" (which forecloses the only way to actually do that). **What was amended:** Code Map now specifies adding `getRoutes()` to `api-client.ts`, explicitly mirroring `fetchFleetOnce`'s normalize-to-`TransportResult` shape but without `getFleet`'s breaker wrapping (breaker is FR-25-specific to `GET /api/fleet`); Tasks gained the `getRoutes()` task and the `hydrateRoutes()` task now explicitly says "must go through api-client.ts, never a raw fetch"; added a new frozen-adjacent Acceptance Criterion banning any `fetch` call under `src/app/` or `src/ui/`; Design Notes spells out the "exactly, including calling through api-client.ts" instruction without room for reinterpretation. **Known-bad state avoided:** a second, inconsistent `fetch` call site outside the mutation gate, silently violating AD-7 with no breaker/error-normalization behavior and no enforcement to catch a future recurrence. **KEEP (in addition to everything kept from iteration 1):** all of iteration 1's `routesSlice`/`RoutesPanel`/wiring work was correct and only the fetch *mechanism* needs to change — `hydrateRoutes()`'s call sites (bootstrap + `onConnect`), its use of `applyRouteAssigned` for writes, and its best-effort (no error UI) handling all stay exactly as iteration 1 built them; only the body of the function changes from a raw `fetch(...).then(...)` chain to `await apiClient.getRoutes()` with the same downstream loop over the result's `data`.

- **Iteration 3 (bad_spec):** Triggering finding — two independent review layers (blind-hunter, verification-gap) both traced that `hydrateRoutes()` fires twice on the app's very first WS connection: once from an explicit call right after `wsManager.connect()` in `createBootstrap()`, and again from inside `onConnect`, which — per `ws-manager.ts`'s own doc comment, read directly — "fires once per successful connection (including the first)." Verified by reading both the doc comment and the actual two call sites before accepting the finding; also confirmed `resetPresence()` never needed a second explicit call for the identical reason, meaning this story's own iteration 1-2 Code Map deviated from the pattern it claimed to mirror. A second, independent finding in the same pass — no test renders `<App />` through the real composition root and asserts `RoutesPanel` content is present, unlike story 1.6's own precedent-setting AD-6 test for `PresencePanel` — was folded into this same loopback rather than a separate one. **What was amended:** Code Map/Tasks now specify `hydrateRoutes()` is called from **exactly one** place (inside `onConnect`, no separate bootstrap-time call); added a new Acceptance Criterion and task for the `App.test.tsx` composition-root mount test, plus a task for a test proving the single-call behavior. **Known-bad state avoided:** a redundant `GET /api/routes` round-trip on every single page load (not a correctness bug given the monotonic guard, but a real, avoidable network cost), and a widget whose real-app mounting was never actually verified end-to-end. **KEEP (in addition to everything kept from iterations 1-2):** everything about `hydrateRoutes()`'s internals (the `apiClient.getRoutes()` call, the `applyRouteAssigned` write-through, the best-effort no-error-UI handling) stays exactly as iteration 2 built it — only remove the redundant explicit call site, keep the one inside `onConnect`.

## Design Notes

Cancel is not a distinct endpoint — it is `updateRouteStatus` with `{status: 'cancelled'}`, so `RoutesPanel`'s cancel control and its confirm copy must read as "cancel" to the dispatcher while reusing the same transition call as any other status change. No modal library exists in the repo (confirmed: no prior art) — the destructive-action and FR-34 confirmations should be a small inline conditional-JSX affordance (e.g. an expanded "confirm?" state on the button), not a new dependency.

`hydrateRoutes()` (iteration 1, corrected iteration 2) should mirror `startInitialFleetFetch`'s shape **exactly, including calling through `api-client.ts`** — `startInitialFleetFetch` calls `apiClient.getFleet()`, not a raw `fetch`, and `hydrateRoutes()` must call the new `apiClient.getRoutes()` the same way. Write through `routesSlice`'s own action instead of a dedicated setter — call `applyRouteAssigned` for every route it returns; the existing monotonic guard makes replaying an already-known route (same or lower version) a safe no-op, so no separate "hydrate vs. echo" branching is needed inside the slice itself.

`api-client.ts`'s new `getRoutes()` (iteration 2) is deliberately *not* wrapped in `getFleet`'s breaker/auto-retry loop — that machinery is FR-25-specific to `GET /api/fleet` (see the file's own header comment). `getRoutes()` is a plain single-attempt call returning `TransportResult<Route[]>`, consistent with `hydrateRoutes()`'s already-documented best-effort handling (a failure just means the slice catches up from the next live echo, no error UI, no retry).

## Verification

**Commands:**
- `npm test` -- expected: full suite green including new routes tests
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` + Vite build clean

**Manual checks (if no CLI):**
- `npm start` + `npm run dev`, two tabs: create a route in tab A, confirm it appears in tab B only after the WS echo; transition/reassign/cancel each reflect in both tabs only after their echo; attempt a mutation before registering and see it refused locally with a visible error.
- Create a route, then reload the page (or reconnect the WS by restarting the server): confirm the route still appears and FR-34's warn-and-confirm still fires when creating a second route for that same truck, without needing a fresh live event first.

## Suggested Review Order

**Composition root — wiring hydration and route echoes in (entry point)**

- Start here: `onConnect` fires on every connection including the first, so `hydrateRoutes()` lives here alone — no separate bootstrap-time call (iteration 3's fix for a real double-fetch bug).
  [`bootstrap.ts:128`](../../../../src/app/bootstrap.ts#L128)

- The hydration seam itself — reads through `api-client.ts` only (AD-7), writes through the same action live echoes use, best-effort on failure.
  [`bootstrap.ts:65`](../../../../src/app/bootstrap.ts#L65)

- Route echoes (`route_assigned`/`_updated`/`_reassigned`) commit directly, never through the coalescing scheduler — the AD-16 low-rate framing in one place.
  [`bootstrap.ts:95`](../../../../src/app/bootstrap.ts#L95)

**Store: the AD-16 monotonic-write guard and audit trail**

- The shared core every echo handler (and hydration) funnels through — a stale/duplicate `version` is a silent no-op, no audit row.
  [`routesSlice.ts:87`](../../../../src/store/slices/routesSlice.ts#L87)

- `RoutesSlice` folded into the store as a direct-commit slice alongside the other three.
  [`store.ts:39`](../../../../src/store/store.ts#L39)

**Transport: the new `getRoutes()`, deliberately not breaker-wrapped**

- Single-attempt `GET /api/routes`, normalized the same way `fetchFleetOnce` normalizes `GET /api/fleet` — but FR-25's breaker is fleet-only, so this one is plain.
  [`api-client.ts:255`](../../../../src/transport/api-client.ts#L255)

**UI: the route-lifecycle widget (FR-10, 11, 14, 15, 34)**

- FR-34's warn-and-confirm, re-derived live from the store on every render — never cached, so a route created by someone else mid-dialog is caught.
  [`RoutesPanel.tsx:81`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L81)

- The two-stage arm-then-confirm pattern for cancel/reassign — no modal dependency, pessimistic UI throughout (state only changes on the echo).
  [`RoutesPanel.tsx:197`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L197)

- The one `registerWidget` call — the whole AD-6 contract for adding this widget.
  [`RoutesPanel.tsx:373`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L373)

- The sole line touched to mount it — `FleetOverview.tsx`/`PresencePanel.tsx` stay untouched (AD-6, Never list).
  [`App.tsx:15`](../../../../src/app/App.tsx#L15)

**Peripherals — tests**

- The AD-16 mandated stale-echo no-op, in isolation from the rest of the store.
  [`routesSlice.test.ts:39`](../../../../src/store/slices/routesSlice.test.ts#L39)

- Proves `hydrateRoutes()` fires exactly once on the first connection — the iteration-3 regression test.
  [`bootstrap.test.ts:368`](../../../../src/app/bootstrap.test.ts#L368)

- Proves the widget actually mounts through the real shell, not just in isolation — the iteration-3 verification-gap fix.
  [`App.test.tsx:161`](../../../../src/app/App.test.tsx#L161)
