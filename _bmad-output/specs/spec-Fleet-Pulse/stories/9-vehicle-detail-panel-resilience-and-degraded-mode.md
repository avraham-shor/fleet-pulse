---
title: 'Vehicle detail panel, resilience, and degraded mode'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'cde5041cdfbd27f834981fbcd581451c7e00a256'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/trust-model.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/constants.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A dispatcher can see the fleet overview and manage routes but cannot inspect one truck's live signals or alert it (CAP-7), and when the telemetry stream or fleet API degrades the dashboard gives no explicit, named warning — it just goes quiet or stale-looking (CAP-8). Both are tier-1, non-cuttable (FR-20–FR-24, FR-26–FR-28, FR-32, FR-33).

**Approach:** Build a `VehicleDetail` widget showing per-signal live values with trust badges and bounded-history sparklines, the truck's active route, and an alert-send form whose broadcast is visible to every dispatcher (fleet-slice storage, not local state). In parallel, rebuild `healthSlice` to AD-9's named-conditions shape, feed it from the SSE/WS connection managers and the already-built circuit breaker, render one global degraded banner off it with the existing 5s clear hysteresis, and wire the already-declared-but-unhandled `fleet_reset` message to actually reset every slice.

## Boundaries & Constraints

**Always:**
- Detail panel reads speed/fuel/temperature/mileage exclusively via `selectSignalTelemetry`/`selectEffectiveTrust` (telemetry slice + AD-3 selector) — never `Truck.speed`/`.fuel`/`.engineTemp` off the fleet-slice roster snapshot, which is fetched once and never live-updated.
- Sparklines render `.history.toArray()` from the same per-signal bounded buffer `FleetOverview` already reads (AD-15: store renders it, pipeline feeds it) — no direct call to `GET /api/telemetry/history/:truckId` from the widget.
- Truck selection is new shared store state (a small slice or field), not widget-local — `FleetOverview`'s roster rows become the click affordance; the detail panel is a registered widget (`registerWidget`, gets the standard `ErrorBoundary` for free) that renders a placeholder when no truck is selected.
- Alert send reuses `api-client.ts`'s already-built `sendTruckAlert` (AD-7's one mutation gate) with client-side validation before submit (NFR-7) — no second `fetch` path.
- Incoming `truck_alert` WS messages are handled in `bootstrap.ts` and land in the fleet slice, per-truck, through a new bounded buffer (AD-10) — per the architecture spine's state-mutation table, an alert for an unrecognized `truckId` upserts a stub truck rather than being dropped (CM1).
- `healthSlice` is rebuilt to AD-9's shape: named conditions `telemetryStreamDown`/`fleetFetchFailing`, each set only by its owning transport component (sse-manager for the stream, api-client's breaker for fleet fetch) and cleared only after `BANNER_CLEAR_HYSTERESIS_MS` of continuous health — no widget infers or sets degraded state itself. `effectiveTrust.ts`'s degraded input derives from these two conditions, replacing the current single `isDegraded` boolean.
- The degraded banner is a pure rendering of the health slice, mounted once in `App.tsx`'s shell (global, not per-truck — not a registered widget), naming which condition(s) are down.
- `fleet_reset` gets a real handler in `bootstrap.ts`'s message switch (currently falls to `default`): in order, `pipeline.reset()`, `resetTelemetry()`, `resetObs()`, a routes reset/re-hydration, `resetPresence()`, and `apiClient.forceNextProbe()` when the breaker is open — every primitive already exists and is already documented as a `fleet_reset` step, just unwired.
- Circuit breaker mechanics (FR-25) are already fully built and tested in `api-client.ts` — read `getBreakerState()` into the health slice; do not modify the breaker's own state machine.

**Ask First:** None anticipated — every seam this story needs (`sendTruckAlert`, `forceNextProbe`, the reset actions, the WS `onConnect` hook, `fleet_reset`'s wire type) already exists; nothing requires a new architectural decision beyond following AD-9's already-specified health-slice shape.

**Never:** Add the developer observability panel (FR-30) or dispatcher anomaly view (FR-29) — story 1.10. Fetch telemetry history directly from a widget. Give the detail panel or banner their own degraded/staleness logic outside the existing selector/slice. Touch `RoutesPanel.tsx`'s or `PresencePanel.tsx`'s own mutation/conflict logic — only `FleetOverview.tsx` gets a minimal click-to-select addition. Modify the breaker's probe/threshold logic.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open detail panel | Dispatcher clicks a truck in the roster | Live speed/fuel/temperature/mileage each with `TrustBadge` and a bounded-history sparkline | FR-20, FR-21 |
| No reading yet | Truck has never reported one signal | That signal shows "no trusted reading yet," never a guess | FR-5, FR-20 |
| Send valid alert | Non-empty message submitted | `sendTruckAlert` posts; on 201 the alert appears for every dispatcher, sender included | FR-22, FR-32 |
| Send empty alert | Message field empty/whitespace | Rejected before submission, no request sent | NFR-7 |
| Alert for unrecognized truck | `truck_alert` arrives for a `truckId` outside the current roster | A stub truck is upserted; the alert is not dropped | CM1 |
| Route details | Selected truck has an active route | Destination/status shown; no active route shows a clear empty state | FR-23 |
| Fleet fetch 503 | `GET /api/fleet` returns 503 with `Retry-After` | Retried honoring the header (already built — verify, don't rebuild) | FR-24 |
| Circuit opens | 3rd consecutive 503 | `fleetFetchFailing` true; banner names "fleet fetches failing" after `BANNER_CLEAR_HYSTERESIS_MS` of continuous unhealthy state | FR-25, FR-26 |
| SSE stream drops | `EventSource` errors/closes | `telemetryStreamDown` true; banner names "telemetry stream down" | FR-26, FR-27 |
| Both conditions clear | Breaker closes and SSE reopens | Banner clears only after `BANNER_CLEAR_HYSTERESIS_MS` of continuous health on both — no flap | FR-26, CM2 |
| Fleet reset | `fleet_reset` WS message arrives | Telemetry, anomaly log, routes, presence wiped and refetched/rehydrated; an open circuit gets an immediate probe | FR-33 |
| Unhandled message type | Any other unrecognized/dev-only message | Still safely ignored, no crash | FR-33 |

</frozen-after-approval>

## Code Map

- `src/store/slices/healthSlice.ts:1-34` -- rebuild from `{isDegraded, reason, nowMs}` to AD-9's `{telemetryStreamDown, fleetFetchFailing, nowMs}` with per-condition set actions and hysteresis-gated clear; no `healthSlice.test.ts` exists yet.
- `src/store/selectors/effectiveTrust.ts:26-43` -- `computeEffectiveTrust`'s `isDegraded` param and `selectEffectiveTrust:41`'s `state.health.isDegraded` read must source from the two new conditions instead.
- `src/transport/sse-manager.ts:28-58` -- `CreateSseManagerOptions`/`SseManager` have no connection-status callback today (only `onBatch`/`onDroppedMessage`); add one so `bootstrap.ts` can observe stream up/down.
- `src/transport/ws-manager.ts:74,128-140,252` -- `onConnect` hook already fires on every reconnect (used today for `resetPresence()`/`hydrateRoutes()` at `bootstrap.ts:132,138`) -- reference for the SSE equivalent, not itself changed.
- `src/transport/api-client.ts:82,88,176-181,322` -- `getBreakerState()` and `forceNextProbe()` already built/tested; read-only from this story.
- `src/app/bootstrap.ts:82-106,124,128-140` -- add `case 'fleet_reset'` and `case 'truck_alert'` to `handlePresenceMessage`'s switch (currently `default: return`); wire SSE status + `getBreakerState()` into `healthSlice`.
- `src/store/slices/fleetSlice.ts:17-43` -- add a per-truck bounded `alerts` buffer (AD-10) and an `addTruckAlert` action; upsert a stub `Truck` for an unrecognized `truckId` (CM1).
- `src/store/slices/routesSlice.ts:49-54,112-116` -- add a reset/re-hydration path (no `resetRoutes` exists) and a `selectRouteForTruck` selector (today's only truck→route lookup is `RoutesPanel.tsx:73-75`'s local `findActiveRouteForTruck`).
- `src/store/slices/telemetrySlice.ts:37,81`, `src/store/slices/obsSlice.ts:40,67`, `src/store/slices/presenceSlice.ts:72,142`, `src/pipeline/index.ts:66` -- existing reset primitives, each already documented as a `fleet_reset` step; wire, don't rebuild.
- New `src/store/slices/selectionSlice.ts` -- `selectedTruckId: string | null` + `selectTruck` action; the seam `FleetOverview` and `VehicleDetail` share.
- `src/ui/widgets/fleetOverview/FleetOverview.tsx:69-75` -- add a click handler on each roster row dispatching `selectTruck` (`TruckRosterRow`); no other change to this file.
- `src/ui/TrustBadge.tsx` -- reuse as-is, once per signal, exactly as `FleetOverview.tsx:75` calls it today.
- `src/ui/registry.ts:11-37` -- `registerWidget` for the new widget, same as `FleetOverview.tsx:141`/`RoutesPanel.tsx:498`/`PresencePanel.tsx:148`.
- New `src/ui/widgets/vehicleDetail/VehicleDetail.tsx` + `.module.css` -- the panel: per-signal badge+sparkline, route details, alert form.
- New `src/ui/widgets/vehicleDetail/sparkline.ts` -- bounded-history → SVG-path helper, mirroring `fleetOverview/project.ts`'s shape.
- New `src/ui/DegradedBanner.tsx` -- pure render of `health`'s two conditions.
- `src/app/App.tsx:13-15,26-29` -- side-effect import the new widget; mount `DegradedBanner` in the shell (not through the registry).
- `src/contract/rest.ts:64-70,135-137` (`TruckAlert`, `SendTruckAlertRequestBody`), `src/contract/ws-server.ts:73-81` (`TruckAlertMessage`, `FleetResetMessage`) -- already declared, no contract changes.

## Tasks & Acceptance

**Execution:**
- [x] `src/store/slices/healthSlice.ts` -- AD-9 named-conditions rebuild with hysteresis-gated clear -- FR-26, AD-9
- [x] `src/store/selectors/effectiveTrust.ts` -- derive degraded input from the two conditions -- AD-3, AD-9
- [x] `src/transport/sse-manager.ts` -- connection-status callback option -- FR-26, FR-27
- [x] `src/app/bootstrap.ts` -- wire SSE status + breaker state into health slice; add `fleet_reset`/`truck_alert` switch cases -- FR-26, FR-32, FR-33
- [x] `src/store/slices/fleetSlice.ts` -- per-truck bounded `alerts` buffer + `addTruckAlert`, stub-upsert on unknown id -- FR-32, CM1
- [x] `src/store/slices/routesSlice.ts` -- reset/re-hydration path + `selectRouteForTruck` -- FR-23, FR-33
- [x] `src/store/slices/selectionSlice.ts` (new) -- `selectedTruckId` + `selectTruck` -- FR-20
- [x] `src/ui/widgets/fleetOverview/FleetOverview.tsx` -- roster-row click dispatches `selectTruck` -- FR-20
- [x] `src/ui/widgets/vehicleDetail/VehicleDetail.tsx` + `.module.css` (new) -- badges, sparklines, route details, alert form; `registerWidget` -- FR-20, FR-21, FR-22, FR-23
- [x] `src/ui/widgets/vehicleDetail/sparkline.ts` (new) -- history-to-path helper -- FR-21
- [x] `src/ui/DegradedBanner.tsx` (new) -- pure health-slice render -- FR-26
- [x] `src/app/App.tsx` -- mount banner, import new widget -- FR-20, FR-26
- [x] Co-located `*.test.ts`/`.test.tsx` for every file above, covering the full I/O matrix -- FR-20–FR-28, FR-32, FR-33

**Acceptance Criteria:**
- Given a truck with live telemetry, when its detail panel opens, then all four signals show their live value, correct trust badge, and a sparkline over the bounded history, matching the effective-trust selector's output.
- Given three consecutive fleet-fetch 503s, when the circuit opens, then the banner names "fleet fetches failing" only after the hysteresis window, and clears the same way on recovery.
- Given a `truck_alert` broadcast, when it arrives, then every connected dispatcher's client shows it, verified against the store, not just the sender's local state.
- Given `npm test`, when it runs, then the full suite passes with no regressions.
- Given `npm run lint` and `npm run build`, when run, then both are clean (`--max-warnings 0`; `tsc -b` + Vite build).

## Spec Change Log

## Design Notes

`selectedTruckId` gets its own tiny slice rather than living on `fleetSlice` or `App.tsx` local state: it's cross-widget (set by `FleetOverview`, read by `VehicleDetail`), and widgets communicate only through the store, never through each other directly or through the shell.

The degraded banner is mounted directly in `App.tsx`, not registered as a widget, because it's global dashboard chrome, not a per-truck panel — nothing in the widget registry model (three independent, individually-erroring panels) fits a single always-present status line.

`healthSlice`'s rebuild is a breaking shape change, not additive: the old `isDegraded`/`reason` fields are replaced, not kept alongside the new ones, since AD-9 already specifies the target shape and nothing besides `effectiveTrust.ts` reads the old fields.

## Verification

**Commands:**
- `npm test` -- expected: full suite green including new health-slice, sparkline, and alert-broadcast tests
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` + Vite build clean

**Manual checks (if no CLI):**
- `npm start` + `npm run dev`: click a truck, confirm live sparklines and trust badges; send an alert, open a second tab and confirm it appears there too; `POST /api/dev/quirk/7` three times to force the circuit open and watch the banner appear, then recover and watch it clear after the hysteresis window.

## Suggested Review Order

**Degraded mode — health slice (AD-9)**

- Named conditions, each cleared only after a healthy period — the hysteresis engine the whole banner depends on.
  [`healthSlice.ts:82`](../../../../src/store/slices/healthSlice.ts#L82)

- Per-condition setters replace the old single `isDegraded` boolean; each condition tracks its own healthy-since clock.
  [`healthSlice.ts:96`](../../../../src/store/slices/healthSlice.ts#L96)

- `effectiveTrust`'s degraded input now derives from the OR of both conditions instead of the removed boolean field.
  [`effectiveTrust.ts:39`](../../../../src/store/selectors/effectiveTrust.ts#L39)

**Feeding health from the connection layer**

- SSE manager's connection-status callback — the new seam `bootstrap.ts` observes stream up/down through.
  [`sse-manager.ts:43`](../../../../src/transport/sse-manager.ts#L43)

- Stream drop/recovery flows straight into `setTelemetryStreamDown`, no intermediate state.
  [`bootstrap.ts:188`](../../../../src/app/bootstrap.ts#L188)

- Breaker state polled into `setFleetFetchFailing` on the existing 1s staleness tick — no new timer.
  [`bootstrap.ts:226`](../../../../src/app/bootstrap.ts#L226)

- Pure render of the two conditions; renders nothing while healthy, now contained in its own `ErrorBoundary`.
  [`DegradedBanner.tsx:22`](../../../../src/ui/DegradedBanner.tsx#L22)
  [`App.tsx:37`](../../../../src/app/App.tsx#L37)

**`fleet_reset` — the six-step reset sequence**

- `truck_alert` and `fleet_reset` land here — the two message types this story adds to a previously-`default`-only switch.
  [`bootstrap.ts:157`](../../../../src/app/bootstrap.ts#L157)

- The reset sequence itself: pipeline, telemetry, obs, routes, presence, alerts, then a forced probe if the breaker is open.
  [`bootstrap.ts:101`](../../../../src/app/bootstrap.ts#L101)

**Vehicle detail panel — selection and signals**

- Roster row becomes a click/keyboard affordance dispatching into the new selection slice.
  [`FleetOverview.tsx:78`](../../../../src/ui/widgets/fleetOverview/FleetOverview.tsx#L78)

- The cross-widget seam itself — deliberately its own tiny slice, not local state (Design Notes).
  [`selectionSlice.ts:28`](../../../../src/store/slices/selectionSlice.ts#L28)

- The panel's entry point: reads every signal through the telemetry slice + trust selector, never the roster snapshot.
  [`VehicleDetail.tsx:232`](../../../../src/ui/widgets/vehicleDetail/VehicleDetail.tsx#L232)

- Per-signal card + sparkline render loop — the four-signal grid FR-20/FR-21 asks for.
  [`VehicleDetail.tsx:258`](../../../../src/ui/widgets/vehicleDetail/VehicleDetail.tsx#L258)

- Bounded-history-to-SVG-path helper, mirroring `fleetOverview/project.ts`'s shape (AD-15: no direct history-endpoint call).
  [`sparkline.ts:30`](../../../../src/ui/widgets/vehicleDetail/sparkline.ts#L30)

- Route details for the selected truck — a small selector that, like `RoutesPanel`'s own local filter, ignores terminal routes.
  [`VehicleDetail.tsx:139`](../../../../src/ui/widgets/vehicleDetail/VehicleDetail.tsx#L139)

**Alerts — send, broadcast, and the reference-reuse fix**

- Rebuilds a fresh buffer on every push (not a mutate-in-place) so a second alert to an already-open panel actually re-renders — the bug all three review layers converged on, now fixed.
  [`fleetSlice.ts:98`](../../../../src/store/slices/fleetSlice.ts#L98)

- Unknown-truck alerts upsert a stub roster entry rather than being dropped (CM1).
  [`fleetSlice.ts:118`](../../../../src/store/slices/fleetSlice.ts#L118)

- Alert form keyed by the selected truck id, so switching trucks discards any in-progress draft instead of leaking it.
  [`VehicleDetail.tsx:275`](../../../../src/ui/widgets/vehicleDetail/VehicleDetail.tsx#L275)

**Registration and tests**

- Registered like every other panel — gets the standard `ErrorBoundary` for free.
  [`VehicleDetail.tsx:282`](../../../../src/ui/widgets/vehicleDetail/VehicleDetail.tsx#L282)

- Full I/O-matrix coverage plus the post-review regressions (reference-reuse, form-leak, reset-wipe, cap-sibling, recovery-direction).
  [`VehicleDetail.test.tsx:1`](../../../../src/ui/widgets/vehicleDetail/VehicleDetail.test.tsx#L1)
  [`healthSlice.test.ts:1`](../../../../src/store/slices/healthSlice.test.ts#L1)
  [`bootstrap.test.ts:1`](../../../../src/app/bootstrap.test.ts#L1)
