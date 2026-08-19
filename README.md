# FleetPulse

A real-time fleet-dispatch dashboard: a self-built mock server plus a React/TypeScript
client giving a dispatcher a live, trustworthy picture of a 12-truck fleet — telemetry
they can trust, presence, route lifecycle with concurrency-safe conflict resolution, and
resilience under a deliberately unreliable stream.

## Run it

Requires Node 24 LTS (see `.nvmrc`).

```bash
npm install
npm start   # server.js (:3000) + Vite dev client, concurrently
npm test    # vitest run
npm run lint   # oxlint, --max-warnings 0
npm run build  # tsc -b && vite build
```

`server.js` listens on `:3000`; Vite's dev server proxies `/api` and `/ws` to it
(`vite.config.ts`), so the browser only ever talks to one origin. `PORT=4123 npm start`
moves both legs together. Use `npm run dev` for the client alone against an
already-running server.

## Architecture and data flow

Four layers, one direction, mapped one-to-one onto `src/`:

```
transport/  →  pipeline/  →  store/  ←  ui/
(sockets/HTTP) (framework-free) (one Zustand  (React,
                                   store)       render-only)
```

`app/` is the composition root (`bootstrap.ts`) — the only module allowed to wire the
others together. Nothing above `transport/` calls `fetch` or opens a socket directly;
nothing in `pipeline/` imports React, DOM, or the store; `ui/` never reaches past
`store/` into transport, except the one narrow facade `ws-manager.ts` exposes
(`register`, `sendViewing`, and a read-only `getDispatcherId`) — `PresencePanel` sends
through it directly, and `RoutesPanel`/`VehicleDetail` read the live dispatcher id from
it to construct their own `api-client` instances, rather than importing `ws-manager`
outright.

**Telemetry (SSE → pipeline → store → UI), the trustworthy path:**

1. `transport/sse-manager.ts` owns the one `EventSource` for
   `GET /api/telemetry/stream`, reconnecting on error with 1s→15s doubling backoff. Every
   parsed frame — a `TelemetryBatch` of 1–30 readings for one truck — is handed to an
   injected `onBatch` callback; a frame that fails to parse is dropped and counted, never
   thrown.
2. `pipeline/index.ts`'s `ingest()` orders the batch's readings by their own
   `readingTs` against that truck's cursor (`pipeline/order.ts`) — a reading older than
   the truck's current state backfills bounded history instead of overwriting live state
   (FR-6). Each reading is then run through every registered signal classifier
   (`pipeline/signals/`) — speed, fuel, temperature, mileage, position — which assigns
   one of three trust states (`trusted` / `suspect` / `sensor-fault`) and emits an
   anomaly-log entry for anything rejected or resolved (AD-3, AD-18).
3. The pipeline emits one batched commit per `ingest()` call to an injected `onCommit`,
   plus any anomalies to `onAnomaly`. `store/store.ts`'s coalescing scheduler buffers
   these (and WS `dispatcher_viewing` churn) and flushes at most
   `RENDER_COALESCE_MAX_COMMITS_PER_SEC` (10) times/sec into one `set()` call spanning
   the telemetry and obs slices — a flood of SSE frames costs at most 10 renders/sec, not
   one render per reading (NFR-1).
4. Widgets subscribe to the store via selectors (`selectSignalTelemetry`,
   `selectEffectiveTrust`, `selectFleetTrucks`, …) — never a component-local copy of
   fleet state. `store/selectors/effectiveTrust.ts` is the *one* place staleness (arrival
   clock) and degraded mode (health slice) layer on top of the pipeline's own plausibility
   trust, so a value is always in exactly one of the five trust states, rendered through
   one shared `TrustBadge` component (AD-3).

**Presence, routes, and alerts (WS → store), the low-rate path:** `transport/ws-manager.ts`
owns the one `WebSocket`, parses each frame against `contract/ws-server.ts`'s message
union, and dispatches straight to the owning slice — presence
(`dispatcher_joined`/`_left` direct-commit, `dispatcher_viewing` through the same
coalescing scheduler above), routes (`route_assigned`/`_updated`/`_reassigned`, the *sole*
writer of the routes slice — AD-16), and `truck_alert` (FR-32). These never touch
`pipeline/` — only SSE telemetry and history backfill do (AD-1).

**Mutations (UI → api-client → server, echoed back over WS):** `transport/api-client.ts`
is the one place any HTTP mutation is sent — it injects `X-Dispatcher-Id` on every
mutation and `If-Match` on version-checked route mutations, and normalizes every
possible failure to one 3-kind union (`conflict` / `retryable` / `error`) so nothing
above transport ever sees a raw `Response` or a thrown fetch error. A 2xx response only
clears a widget's own in-flight indicator — it never writes route state itself; the
route only actually changes once the server's WS echo of the same event lands back
through the path above (AD-16). This is deliberately pessimistic: on-screen state moves
only after the server confirms it.

## Key decisions and trade-offs

- **No map/chart library, hand-rolled SVG** (AD-14). The fleet grid is a coordinate
  projection over live lat/lng bounds; detail sparklines are small SVG polylines over
  bounded history. Zero dependencies, deterministic for the demo; map/chart *visual*
  quality was explicitly out of scope.
- **Coalesced, not throttled-per-widget, rendering** (AD-5). One scheduler batches every
  pipeline commit and presence-viewing update into ≤10 `set()` calls/sec, globally —
  simpler to reason about than per-widget throttling, and the NFR-1 flood test asserts
  the ceiling directly.
- **Pessimistic UI over optimistic-with-rollback** (AD-7). Every mutation shows an
  in-flight indicator and only updates on 2xx-then-WS-echo; there is no optimistic local
  state to roll back on a 409, which sidesteps a whole class of "revert the guess" bugs
  at the cost of one extra round trip (the WS echo) before a change is visible to its own
  author.
- **Trust is assigned once, in the pipeline, never re-derived by a widget** (AD-3). Every
  value crossing into the store is a `Reading<T>` envelope (`{value, trust, readingTs,
  arrivalTs}`); a widget renders the trust it's given through the one shared
  `TrustBadge`, it never re-runs plausibility logic itself.
- **Registration over modification for extensibility** (AD-6, NFR-9) — see the
  tire-pressure worked example below.
- **Self-imposed test coverage beyond the mandated six areas.** The assignment's own
  "hard parts" (GPS batching, out-of-order timestamps, the fuel hybrid classifier, the
  two speed branches, optimistic-locking conflicts, ghost presence) account for 14 of the
  mandated cases; the circuit breaker (FR-25), the busy-truck creation guard (FR-34), and
  this story's anomaly-view/dev-metrics coverage (FR-29/FR-30) were added on top because
  they're real product surfaces with the same "no it-renders tests" bar — see
  `_bmad-output/specs/spec-Fleet-Pulse/test-matrix.md` for the full table.
- **Local-only submission, by design.** No deploy target, no persistence beyond the
  server process's in-memory state, no CI — the brief scopes this as an evaluator-run,
  local demo (`requirements.md`'s Deliverables). `DECISIONS.md` records every build-time
  choice with its FR/NFR/AD citation; open questions closed along the way are recorded
  there too.

## Multi-dispatcher conflict handling

Two mechanisms cover the two moments a conflict can happen — *before* a save (avoidance)
and *at* a save (resolution) — because the WS route events every dispatcher already
receives (AD-16) make both essentially free:

- **Avoidance, ahead of time (FR-31).** While a dispatcher has a route open for editing,
  an incoming `route_updated`/`_reassigned` for that same route surfaces inline — who
  changed it, and that the version has moved — *before* a save is even attempted. No new
  transport: the same WS echo every client already receives for AD-16's sole-writer rule.
- **Resolution, at save time (FR-12/FR-13).** Every route mutation carries the version it
  was read at (`If-Match`); the server rejects a stale write with `409` (never applies it
  silently), whether the staleness was already true when the request was sent (a plain
  stale-version conflict) or only became true mid-request (the PATCH-race failure mode —
  both land through the identical conflict path). The 409 body carries the conflicting
  dispatcher's id *and* display name plus the current server-side route state, so the
  conflict view never needs a separate presence lookup to attribute the change (AD-11).
  `RoutesPanel`'s `ConflictChooser` then shows the dispatcher's own intended change
  side by side with the current server state and offers three ways forward: **Adopt**
  the server's version (discard the local intent), **Re-apply** the same intended change
  against the fresh version (a new `If-Match`, which can itself conflict again if a third
  write races in), or **Back out** entirely. No silent overwrite, no silent discard,
  either way.
- **Attribution never depends on presence.** Because the 409 body already carries the
  conflicting dispatcher's display name, a conflict is fully explainable even if that
  dispatcher has since disconnected and dropped out of the presence list.

## Known issues and what's next

- **No CI workflow.** `npm test`/`npm run lint`/`npm run build` are all run by hand for
  every story (recorded in `DECISIONS.md`); there is no `.github/workflows/` wiring them
  into an automated green/red signal on push.
- **NFR-3's 8-hour-shift memory claim is verified structurally, not by a soak run.**
  Every in-memory collection (telemetry history, anomaly log, audit trail, truck alerts)
  goes through the one `boundedBuffer` utility with a cap asserted in a test — the caps
  make an unbounded leak impossible by construction, but nobody has actually run the app
  for 8 continuous hours and watched memory. Noted here as the accepted follow-up
  verification the requirements catalog itself calls out.
- **A few accepted, documented limits inside the frozen requirements themselves:** a
  route audit trail is session-scoped, so a late joiner sees only a partial history
  (FR-15); a dispatcher who reconnects gets a fresh identity, so one person's actions can
  span two audit-trail identities mid-shift (FR-16); presence viewing is truck-level, not
  route-level — "X is looking at truck #3," not "X is editing this route" (FR-18).
- **No accessibility pass.** No WCAG/screen-reader requirement exists anywhere in this
  project's FRs/NFRs, so none was added unprompted; a few gaps (missing `aria-live`
  regions on live-updating panels, an interruptive `role="alert"` on the degraded banner)
  are logged in `_bmad-output/implementation-artifacts/deferred-work.md` for whenever an
  accessibility bar is actually set.
- **Tier 3, not attempted (by design — CM3: depth over breadth).** Filterable fleet view,
  keyboard shortcuts, and geofencing alerts were explicitly gated on tiers 1–2 being
  green first (`requirements.md`'s Scope tiers) — depth on the eight mandated failure
  modes outranks bonus-feature breadth.
- **The dev panel's SSE events/sec briefly under-reports after a fresh connect or a quiet
  gap.** `getEventsPerSecond()` divides a rolling frame count by the *full* sampling
  window rather than by time-since-oldest-counted-frame, so for the first
  `SSE_EVENTS_PER_SEC_WINDOW_MS` (5s) after reconnecting, or after any quiet gap, the
  reported rate reads lower than the real instantaneous rate. Matches the story's own
  Design Notes (a fixed-window average, not an elapsed-time-based one) — self-corrects
  once the window fills with real frames, so it's a brief cold-start artifact, not a
  standing inaccuracy.
- Every other real gap surfaced during development — surviving edge cases, minor UX
  rough edges, small duplicated helpers — is logged with its own evidence and rationale
  in `_bmad-output/implementation-artifacts/deferred-work.md`, one entry per story's code
  review pass.

## Extensibility: adding a signal (NFR-9 worked example)

NFR-9's acceptance criterion is this exact walkthrough: adding a new telemetry signal is
a **registration**, never an edit to an existing module. Say the brief grew a ninth
failure mode — a tire-pressure sensor that occasionally reports an implausible spike.
Here is every seam it would touch, and nothing else:

1. **Wire shape** (`src/contract/telemetry.ts`) — add `tirePressure: number` to
   `TelemetryReading`. The one contract module every layer imports; `server.js` would
   start emitting it in the same tick as every other signal.
2. **Classifier** (new file `src/pipeline/signals/tirePressure.ts`) — call
   `registerSignal({ name: 'tirePressure', extractRawValue, createInitialState, classify
   })`, mirroring `speed.ts`'s own shape exactly: pull the raw value off the reading,
   decide `trusted`/`suspect`/`sensor-fault` against a threshold, emit an `AnomalyEntry`
   for anything rejected. Any new tunable threshold this classifier needs (e.g. a
   plausible PSI ceiling) is one addition to `shared/constants.js` — the one module every
   tunable lives in (AD-2) — never a literal inside the classifier file.
3. **Wire it into the pipeline** (`src/pipeline/index.ts`) — one new side-effect import
   line, `import './signals/tirePressure.ts'`, next to `speed.ts`/`fuel.ts`'s own. The
   classifier's own `registerSignal()` call does the rest; `pipeline/index.ts`'s
   ingest/classify loop already iterates every registered signal generically — it never
   needs to know a tire-pressure signal exists.
4. **Store** — nothing to add. `telemetrySlice.ts` already stores a live value + bounded
   history keyed by *signal name*, generically, for every registered signal; a new
   `SignalName` union member is the only touch (a type-level addition, not a rebuild of
   the slice's logic).
5. **UI** (new files `src/ui/widgets/tirePressure/TirePressureGauge.tsx` + `.module.css`,
   or a new `SignalCard` entry in `VehicleDetail.tsx`'s existing `SIGNALS` array) — reads
   `selectSignalTelemetry(state, truckId, 'tirePressure')` and
   `selectEffectiveTrust(truckId, 'tirePressure')` exactly like every other signal card,
   rendered through the same shared `TrustBadge` — no new trust-visual invented per
   widget (AD-3). If it's its own standalone panel rather than a `VehicleDetail` row, one
   `registerWidget()` call plus one new side-effect import line in `App.tsx` is the whole
   integration — the same seam this story's own `AnomalyView`/`DevMetrics` panels used.

Total edits to *existing* files: one import line in `pipeline/index.ts`, one field in the
contract type, one `SignalName` union member. Everything else this example needs is a new
module calling one `register*()` function — which is the whole point of AD-6's three
registries (signals, anomaly rules, widgets): the pipeline core, the store, and the widget
shell never change shape to accommodate a new sensor, vehicle type, or panel.

## Project docs

- Spec: `_bmad-output/specs/spec-Fleet-Pulse/SPEC.md`
- Requirements catalog: `_bmad-output/specs/spec-Fleet-Pulse/requirements.md`
- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md`
- Decisions log: `DECISIONS.md`
- AI usage journal: `PROMPTS.md`
- Test coverage matrix: `_bmad-output/specs/spec-Fleet-Pulse/test-matrix.md`

---

_Scaffolded from `create-vite` (react-ts). Oxlint config and React Compiler notes below
are the template's own, kept as-is per the architecture's lint convention._

## React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

### React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

### Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
