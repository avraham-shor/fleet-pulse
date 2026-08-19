---
title: 'Live fleet overview'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'a5a750d3a2c5274d5ffa2fbf806b4a322d4c43c7'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/trust-model.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The pipeline/store (story 1.4) classify and hold telemetry, but nothing renders yet — there is no live UI, no widget shell, and no wiring from transport through to a rendered screen. A dispatcher has nothing to look at.

**Approach:** Build CAP-2 (FR-1–4, FR-28): an SVG coordinate grid showing all 12 trucks with distinct status styling, newest-by-timestamp batch snapping with a sorted trail, and staleness badges — plus the `app/` composition root (first UI story to need one), the widget registry, per-widget error boundaries, and the shared `TrustBadge` every later widget reuses.

## Boundaries & Constraints

**Always:**
- `app/` is the sole bridge from transport lifecycle into `pipeline`/`store` (AD-1): construct `createApiClient`, `createSseManager`, `createPipeline`, `createFleetPulseStore` + `createCoalescingCommitScheduler`; wire `pipeline.onCommit`→`scheduler.ingestPipelineCommit`, `onAnomaly`→`scheduler.ingestAnomalies`, `sseManager`'s `onBatch`→`pipeline.ingest`; call `apiClient.getFleet()` once at startup for the initial 12-truck roster (SSE delivers deltas only); start one `STALENESS_TICK_MS` interval calling `tickEffectiveTrust`. Guard `connect()`/the initial fetch against React 19 StrictMode's dev double-invoke (idempotent/once-only).
- `ui/` may import only `store/` (selectors + the new fleet slice), never `pipeline/` or transport directly (AD-1).
- Widgets, once built, are registered via one `registerWidget` call each (AD-6) and mounted by the shell inside their own `ErrorBoundary` (FR-28) — a throwing widget must not take down its siblings.
- The SVG grid auto-fits its viewBox from the live lat/lng range of the 12 trucks (padded) — no hardcoded coordinate bounds (server's `MAP_LAT/LNG_*` are server-internal, not a shared contract value, per `server.js:130-134`).
- Marker position snaps to the newest-**by-timestamp** reading in a batch, never the last array element (FR-3); the trail is one polyline sorted by `readingTs` over the position signal's bounded history (already capped at `TELEMETRY_HISTORY_CAP_PER_SIGNAL`, AD-15) — a batch never renders as separate markers.
- Staleness reads the arrival clock only, via `selectEffectiveTrust(truckId, 'position')` (position carries every truck's per-batch arrival time); trust annotations render inline, never a modal (CM2).
- Server-originated text (truck id, status) renders as text nodes only — no `dangerouslySetInnerHTML`.

**Ask First:** None anticipated.

**Never:** Open the WS connection or consume `ws-manager`/presence (story 1.6's job); build `routes`/`presence` store slices; add any new npm dependency (`@testing-library/jest-dom` included — use Testing Library's own queries and Vitest matchers); add a map or chart library (AD-14); populate `health` from real signals (story 1.9); touch `vite.config.ts`'s global test environment — use a per-file `// @vitest-environment jsdom` pragma on new UI tests so pipeline/store's framework-free node tests are untouched.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| GPS batch, 30 readings | Non-monotonic batch arrives via SSE for one truck | Marker snaps to newest-by-timestamp position; trail redraws as one sorted polyline; no flicker/stall | Never renders as separate markers (mandated test, FR-3) |
| Truck goes stale | No reading past `STALENESS_BADGE_THRESHOLD_MS` since last arrival | That truck's marker carries the stale `TrustBadge` | A late batch of old timestamps still clears staleness (arrival clock only) |
| Initial fleet fetch pending | App mounts before `getFleet()` resolves | Grid renders an empty/loading state, no crash | N/A |
| Initial fleet fetch exhausted | `getFleet()` resolves to the error variant after breaker/retry budget | Grid shows an inline "fleet unavailable" state | Never a modal (CM2) |
| One widget throws during render | A widget component throws | Its `ErrorBoundary` shows a contained fallback; other registered widgets keep working | FR-28 |

</frozen-after-approval>

## Code Map

- `src/pipeline/index.ts:74` (`createPipeline`) -- factory this story's `app/` wires to live transport
- `src/store/store.ts:27` (`createFleetPulseStore`), `:59` (`createCoalescingCommitScheduler`) -- store + commit scheduler this story instantiates
- `src/store/selectors/effectiveTrust.ts:37-43` (`selectEffectiveTrust`), `:46-53` (`tickEffectiveTrust`) -- five-state trust read + the tick this story must start
- `src/store/slices/telemetrySlice.ts:17-26,85-91` (`TelemetryState`, `selectSignalTelemetry`) -- per-truck per-signal envelope + bounded history the grid reads for position/trail
- `src/transport/sse-manager.ts:28-42,76` (`createSseManager`, default url `/api/telemetry/stream`) -- telemetry stream this story connects
- `src/transport/api-client.ts:33-51,178-240` (`createApiClient`, `getFleet()` → `GET /api/fleet`) -- initial 12-truck roster fetch, breaker-guarded
- `src/contract/rest.ts:11,17-30` (`TruckStatus`, `Truck`) -- roster shape (`truckId`, `status`, `lat`, `lng`, ...)
- `src/contract/telemetry.ts:21-45` (`TelemetryReading`, `TelemetryBatch`) -- lat/lng live here, not x/y; grid must project
- `ARCHITECTURE-SPINE.md` AD-1 (ui/app import boundaries), AD-6 (signal/anomaly-rule/**widget** registries), AD-14 (no map lib, SVG grid + trail polylines), AD-15 (trail = position's bounded history)
- `shared/constants.js` -- `STALENESS_BADGE_THRESHOLD_MS` (10s), `RENDER_COALESCE_MAX_COMMITS_PER_SEC` (10), `STALENESS_TICK_MS` (1s) -- no new constants needed this story
- `src/App.tsx`, `src/App.css`, `src/index.css` -- untouched Vite demo scaffold, wholesale replace
- `src/main.tsx` -- update import from `./App` to `./app/App`
- `src/store/slices/fleetSlice.ts` (new) -- truck roster slice (`trucks: Record<string, Truck>`, `setFleet` action) -- this story's slice per story 1.4's Design Notes deferral
- `src/ui/registry.ts` (new) -- `registerWidget`/`getWidgets` (AD-6)
- `src/ui/ErrorBoundary.tsx` (new) -- per-widget error boundary (FR-28)
- `src/ui/TrustBadge.tsx` (new) -- shared badge over `EffectiveTrust | null`, per `trust-model.md`'s five-state display rules
- `src/ui/widgets/fleetOverview/` (new) -- `FleetOverview.tsx` (SVG grid + markers + trail), `project.ts` (lat/lng → SVG coords, auto-fit bounds)
- `src/app/bootstrap.ts`, `src/app/App.tsx` (new) -- composition root: wiring + widget shell

## Tasks & Acceptance

**Execution:**
- [x] `src/store/slices/fleetSlice.ts` -- new roster slice + `setFleet` action -- CAP-2 needs status/id beyond telemetry
- [x] `src/store/store.ts` -- fold `FleetSlice` into `FleetPulseStore` -- AD-5
- [x] `src/ui/registry.ts` -- widget registry -- AD-6
- [x] `src/ui/ErrorBoundary.tsx` -- per-widget boundary -- FR-28
- [x] `src/ui/TrustBadge.tsx` -- shared five-state badge -- trust-model.md
- [x] `src/ui/widgets/fleetOverview/project.ts` -- lat/lng → SVG projection, auto-fit -- AD-14
- [x] `src/ui/widgets/fleetOverview/FleetOverview.tsx` -- grid + 12 markers + trail + staleness, registers itself -- FR-1–4
- [x] `src/app/bootstrap.ts` -- wire apiClient/sseManager/pipeline/store/scheduler, StrictMode-safe -- AD-1
- [x] `src/app/App.tsx` -- mounts bootstrap once + widget shell -- AD-6
- [x] `src/main.tsx` -- point at `./app/App`
- [x] Delete `src/App.tsx`, `src/App.css`; replace `src/index.css` with a minimal reset
- [x] Co-located `*.test.tsx`/`.test.ts` (jsdom pragma) for: GPS-batch newest-snap + trail (mandated), staleness badge, fetch-pending/error states, error-boundary containment, projection math

**Acceptance Criteria:**
- Given the app mounts and `GET /api/fleet` resolves, when the store updates, then all 12 trucks render with status-distinct styling (FR-1/FR-2).
- Given a later story adds a new widget, when it registers via `registerWidget`, then no existing widget file changes (AD-6).
- Given `npm test`, when it runs, then the full suite (existing 138 + new) passes.

## Design Notes

**Why status comes only from the initial `GET /api/fleet` snapshot this story:** status changes are driven by route mutations (story 1.7) and presence isn't wired until 1.6 — within 1.5's scope status is inherently static after the initial fetch, so no live status-update path is built yet; this is a natural consequence of build order, not a gap.

**Why `position`'s effective trust stands in for "truck-level" staleness:** every wire batch carries all signals for a truck together (confirmed in story 1.4), so position's arrival time is the truck's last-contact time — no need for a separate per-truck staleness concept.

## Verification

**Commands:**
- `npm test` -- expected: full suite green including new UI tests
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` + Vite build clean

**Manual checks (if no CLI):**
- `npm start` + `npm run dev`: 12 trucks visible on the grid within a few seconds, status visually distinct, positions move as telemetry streams in.

## Suggested Review Order

**Entry point — the composition root (AD-1)**

- `createBootstrap`: constructs apiClient/sseManager/pipeline/store/scheduler and wires every seam in one place — everything else plugs into this.
  [`bootstrap.ts:45`](../../../../src/app/bootstrap.ts#L45)

- `App`'s mount effect calls `getBootstrap()` once; the side-effect import above it is the "one import line" AD-6 asks for when a widget registers.
  [`App.tsx:9`](../../../../src/app/App.tsx#L9)

- Review-round fix: the `setInterval` id is now captured and cleared in `resetBootstrapForTests`, closing a reset+rebootstrap interval leak.
  [`bootstrap.ts:33`](../../../../src/app/bootstrap.ts#L33)

- Review-round addition: the only test that renders the real `App` and proves registration + bootstrap fire together, not just in isolation.
  [`App.test.tsx:85`](../../../../src/app/App.test.tsx#L85)

**Widget registry & containment (AD-6, FR-28)**

- `registerWidget`: duplicate-id throws loudly, mirroring `pipeline/signals/registry.ts`'s own pattern from story 1.4.
  [`registry.ts:25`](../../../../src/ui/registry.ts#L25)

- `ErrorBoundary.componentDidCatch`: a throwing widget's fallback names the widget; siblings mounted in their own boundary keep working.
  [`ErrorBoundary.tsx:29`](../../../../src/ui/ErrorBoundary.tsx#L29)

**Fleet overview rendering (FR-1–4)**

- `FleetOverview`: pending/error/ready branches, then one marker + trail per truck sourced from the store's already-ordered position history.
  [`FleetOverview.tsx:80`](../../../../src/ui/widgets/fleetOverview/FleetOverview.tsx#L80)

- `TruckMarkerGroup`: the marker snaps to the pipeline's own `latest` envelope (never recomputes ordering in `ui/`) and draws the full sorted trail.
  [`FleetOverview.tsx:36`](../../../../src/ui/widgets/fleetOverview/FleetOverview.tsx#L36)

- `createProjection`/`computeBounds`: auto-fits the SVG viewBox from the live fleet's own lat/lng range — no hardcoded map bounds (AD-14).
  [`project.ts:56`](../../../../src/ui/widgets/fleetOverview/project.ts#L56)

- Review-round fix: `isLatLng` now requires `Number.isFinite` on both axes — one corrupted reading no longer poisons every truck's shared bounding box.
  [`project.ts:44`](../../../../src/ui/widgets/fleetOverview/project.ts#L44)

**Store foundation for this story (AD-5)**

- `createFleetSlice`: the roster snapshot (`setFleet`/`setFleetFetchFailed`) this story adds, per story 1.4's own deferral.
  [`fleetSlice.ts:33`](../../../../src/store/slices/fleetSlice.ts#L33)

- `getFleetPulseStore`: the one memoized production store instance, so `ui/` reaches it without ever importing `app/` (AD-1).
  [`store.ts:53`](../../../../src/store/store.ts#L53)

**Shared trust display**

- `TrustBadge`: the one component every widget renders trust through — `null` is FR-5's cold-start case, not a sixth state.
  [`TrustBadge.tsx:26`](../../../../src/ui/TrustBadge.tsx#L26)

**Tests & peripherals — review-round fixes**

- The mandated FR-3 case: a non-monotonic 30-reading batch snaps to the newest position and draws one full sorted trail.
  [`FleetOverview.test.tsx:83`](../../../../src/ui/widgets/fleetOverview/FleetOverview.test.tsx#L83)

- Review-round fix: asserts against `CLIENT_THRESHOLDS.STALENESS_TICK_MS` itself instead of a magic `5_000`.
  [`bootstrap.test.ts:103`](../../../../src/app/bootstrap.test.ts#L103)
