---
title: 'Dispatcher presence'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: '302af83fafdefb3268749283dfef0fb682708491'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The dashboard (story 1.5) is anonymous and single-viewer — no dispatcher identity exists, nobody can see who else is active or what they're looking at, and `app/` still hardcodes `getDispatcherId: () => null`, deferred since story 1.3.

**Approach:** Build CAP-6 (FR-16–19): wire `wsManager` into `app/bootstrap.ts`, add a presence store slice fed by `dispatcher_joined`/`_left`/`_viewing` broadcasts with a liveness-timeout sweep for FR-19's ghost rules, and a presence widget for registration, the active-dispatcher list, and a truck-viewing selector.

## Boundaries & Constraints

**Always:**
- Presence keyed only by server-issued `dispatcherId` (FR-19) — never dedupe/merge by name. Any action for an unknown/already-removed id is a silent no-op.
- Own identity never enters the presence slice (AD-17) — the widget tracks "registered as X" as local component state, optimistic on submit.
- `dispatcher_joined`/`dispatcher_left` commit directly (AD-5, low-rate); `dispatcher_viewing` rides `createCoalescingCommitScheduler` via a third pending buffer + pure reducer, mirroring `pushAnomaliesPure` (`obsSlice.ts:56`).
- A liveness sweep, piggybacked on `bootstrap.ts`'s staleness interval, evicts entries silent for `PRESENCE_LIVENESS_TIMEOUT_MS`; `dispatcher_joined` and every viewing update refresh `lastSeenAt`.
- `onConnect` clears the presence slice before the server's replay-on-register rebuilds it fresh (AD-8).
- `wsManager` connects eagerly at bootstrap, no blocking gate (mirrors `sseManager`). `register(name)` sets a mutable current name: sends immediately if open, else rides the existing auto-register-on-open path — never silently dropped.
- `WsManager` gains `register(name)`, reusing `server.js`'s existing re-registration handling (`:721-733`). `ws-manager.ts` exports a narrow `getWsSendFacade()`/`setWsSendFacade()` singleton (mirrors `store.ts`'s `getFleetPulseStore`) exposing only `{register, sendViewing}` — `ui/`'s widened AD-1 facade.
- New widget at `src/ui/widgets/presence/`, one `registerWidget` call (AD-6). Server-originated names render as text nodes only (NFR-8).

**Ask First:** None anticipated.

**Never:** Touch `FleetOverview.tsx` for viewing indicators — a dropdown in the presence widget covers FR-18; marker-click selection stays story 1.9's job. Add a store field for the client's own `dispatcherId` (AD-17). Build route/mutation UI (story 1.7). Invent a bulk presence-snapshot message — replay-on-register (`ws-server.ts:22-25`) is the only rebuild source. Add an npm dependency or touch `vite.config.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Two dispatchers share a name | Both register as "Dana" | Two distinct entries, keyed by `dispatcherId` | FR-19 mandated test |
| Ghost / duplicate / late disconnect | `dispatcher_left` delayed up to `GHOST_DISCONNECT_DELAY_MS`, duplicated, or for an already-removed id | Entry removed exactly once; duplicate/late/unknown-id arrivals are no-ops | FR-19 mandated test |
| Silent vanish | No event for a dispatcher for `PRESENCE_LIVENESS_TIMEOUT_MS` | Sweep removes the entry | FR-19 mandated test |
| Explicit viewing clear | Dispatcher picks "None" in the viewing selector | `sendViewing(null)` sent; peers' entry updates to `viewingTruckId: null` | FR-18 |
| WS reconnect | Socket drops and reopens | Presence slice clears on `onConnect`, rebuilds from the server's replay | AD-8 |

</frozen-after-approval>

## Code Map

- `src/transport/ws-manager.ts:88-112,118,204-207,230-233` (`WsManager`, `createWsManager`, `registered` handling, `onopen` auto-register) -- add `register(name)`; replace the fixed `options.dispatcherName` read with a mutable current-name variable `register()` updates; add `getWsSendFacade()`/`setWsSendFacade()` singleton (mirrors `store.ts:53-56`) exposing only `register`/`sendViewing`.
- `src/contract/ws-server.ts:26-46` (`DispatcherJoinedMessage`/`_Left`/`_Viewing`) -- shapes already declared, no contract changes.
- `src/store/store.ts:23,30-37` (`FleetPulseStore` composition), `:82-130` (`createCoalescingCommitScheduler`, flush at `:101-104`) -- fold in `PresenceSlice`; add a third `pendingViewingUpdates` buffer + `applyPresenceViewingPure` merged into the same `set()`.
- `src/store/slices/obsSlice.ts:56-68` (`pushAnomaliesPure` + `resetObs`) -- template for the new slice's pure-reducer/reset split.
- `src/store/slices/presenceSlice.ts` (new) -- `PresenceEntry {name, viewingTruckId, lastSeenAt}`; `dispatcherJoined`, `dispatcherLeft`, `applyPresenceViewingPure`, `sweepStalePresence(now)` (FR-19), `resetPresence()`, `selectOtherDispatchers`.
- `src/app/bootstrap.ts:35-44` (hardcoded `getDispatcherId: () => null` at `:36`), `:46-60` (`createBootstrap`), `:57` (staleness interval) -- construct/connect `wsManager` (mirrors `sseManager.connect()` at `:55`); wire `onMessage`→presence actions, `onConnect`→`resetPresence()`; replace `:36`'s stub with `wsManager.getDispatcherId`; also sweep presence on the `:57` tick.
- `src/ui/registry.ts:25-33` (`registerWidget`) -- new widget follows `FleetOverview.tsx:141`'s one-line call.
- `src/ui/widgets/presence/PresencePanel.tsx` (new) -- name input + Register button, "You: {name}" local state, `selectOtherDispatchers` rows, a viewing `<select>` (options from `selectFleetTrucks`, `fleetSlice.ts:48`) via `getWsSendFacade()`.
- `shared/constants.js` -- `CLIENT_THRESHOLDS.PRESENCE_LIVENESS_TIMEOUT_MS` (30s), `SERVER_PARAMS.GHOST_DISCONNECT_DELAY_MS` (10s) -- no new constants.
- `server.js:721-755` (`handleRegister`) -- confirms re-registration-over-open-socket and replay-on-register semantics the client design relies on; no server changes.

## Tasks & Acceptance

**Execution:**
- [x] `src/transport/ws-manager.ts` -- add `register(name)` + mutable current-name + `getWsSendFacade`/`setWsSendFacade` -- ui/'s widened AD-1 facade
- [x] `src/store/slices/presenceSlice.ts` (new) -- state, actions, liveness sweep, reset, selector -- FR-16–19
- [x] `src/store/store.ts` -- fold in `PresenceSlice`; extend the coalescing scheduler with the viewing-update buffer -- AD-5
- [x] `src/app/bootstrap.ts` -- construct/connect `wsManager`, wire handlers, live `getDispatcherId`, sweep on the staleness interval -- AD-1, AD-7, AD-8
- [x] `src/ui/widgets/presence/PresencePanel.tsx` (new) -- registration control, active list, viewing selector, registers itself -- FR-17, FR-18
- [x] `src/app/App.tsx` -- one side-effect import line for the new widget -- AD-6
- [x] Co-located `*.test.ts`/`.test.tsx` (jsdom pragma for the widget) covering: the three FR-19 mandated cases, viewing-clear, reconnect-rebuild, the scheduler's viewing buffer, register-before-open

**Acceptance Criteria:**
- Given the app mounts, when the WS socket opens, then the dispatcher auto-registers and can (re-)identify via the presence widget without a reconnect. ✅ `bootstrap.ts` connects `wsManager` eagerly and auto-registers on open; `PresencePanel` re-registers the same socket under a chosen name via `getWsSendFacade().register()`.
- Given a later widget or signal registers itself, when it does, then no existing widget file changes (AD-6). ✅ `FleetOverview.tsx` untouched; only a new widget module + one `App.tsx` import line.
- Given `npm test`, when it runs, then the full suite (existing 138+ new) passes. ✅ 207/207 passing (69 new, including 3 added by this story's code-review pass).

## Design Notes

**`register()` on an already-registered socket still issues a fresh `dispatcherId`** — `server.js:734` calls `randomUUID()` unconditionally, so renaming and reconnecting share one identity-churn path by design (mirrors FR-16's "one person's audit entries may span two identities mid-shift"), no client-side special-casing needed.

## Verification

**Commands:**
- `npm test` -- expected: full suite green including new presence tests
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` + Vite build clean

**Manual checks (if no CLI):**
- `npm start` + `npm run dev`, two tabs: each registers under a different name and sees the other; a viewing-selector pick in one shows up on the other; closing one tab removes it from the other's list.

## Suggested Review Order

**Composition root — wiring the WS manager in (entry point)**

- Start here: constructs/connects `wsManager` eagerly and routes its messages into presence, mirroring `sseManager`.
  [`bootstrap.ts:87`](../../../../src/app/bootstrap.ts#L87)

- Routes `dispatcher_joined`/`_left` to direct commits, `dispatcher_viewing` through the scheduler — the AD-5 split in one place.
  [`bootstrap.ts:59`](../../../../src/app/bootstrap.ts#L59)

- `onConnect` wipes presence before the server's replay-on-register rebuild — AD-8's ordering guarantee.
  [`bootstrap.ts:97`](../../../../src/app/bootstrap.ts#L97)

- FR-19's liveness sweep piggybacks on the pre-existing effective-trust staleness tick, not a new interval.
  [`bootstrap.ts:104`](../../../../src/app/bootstrap.ts#L104)

**Presence state and the FR-19 ghost rules**

- The pure reducer the coalescing scheduler calls — batches viewing updates, silently drops unknown/removed ids.
  [`presenceSlice.ts:80`](../../../../src/store/slices/presenceSlice.ts#L80)

- Keyed only by server-issued `dispatcherId`, never by name — two "Dana"s are two legitimate entries.
  [`presenceSlice.ts:105`](../../../../src/store/slices/presenceSlice.ts#L105)

- A disconnect for an already-removed id is a no-op by construction, not a special case.
  [`presenceSlice.ts:118`](../../../../src/store/slices/presenceSlice.ts#L118)

- Evicts anything silent past `PRESENCE_LIVENESS_TIMEOUT_MS` — the "silent vanish" leg of FR-19.
  [`presenceSlice.ts:127`](../../../../src/store/slices/presenceSlice.ts#L127)

- Sort order (name, then id) for the widget's render — the one rendering-facing selector this slice exposes.
  [`presenceSlice.ts:149`](../../../../src/store/slices/presenceSlice.ts#L149)

**Transport: the mutable-name register() and the narrowed AD-1 facade**

- `register()` sends immediately if open, else just updates the name the next auto-register picks up — never dropped.
  [`ws-manager.ts:292`](../../../../src/transport/ws-manager.ts#L292)

- Code-review patch: an empty name no longer produces a different wire shape depending on whether the socket happens to be open.
  [`ws-manager.ts:301`](../../../../src/transport/ws-manager.ts#L301)

- The narrow `{register, sendViewing}` shape — `ui/`'s only legal reach into transport.
  [`ws-manager.ts:336`](../../../../src/transport/ws-manager.ts#L336)

- `app/` push-sets the singleton once, right after constructing the real manager.
  [`ws-manager.ts:350`](../../../../src/transport/ws-manager.ts#L350)

- Widgets read it lazily; `null` before bootstrap wires it is a normal, handled state, not a crash.
  [`ws-manager.ts:358`](../../../../src/transport/ws-manager.ts#L358)

**Store: the third coalescing buffer**

- `dispatcher_viewing` rides the same batched `set()` as telemetry/obs — one extra buffer, mirroring `pushAnomaliesPure`.
  [`store.ts:113`](../../../../src/store/store.ts#L113)

- The scheduler's public ingest point for viewing updates.
  [`store.ts:132`](../../../../src/store/store.ts#L132)

- `PresenceSlice` folded into the store composition alongside the other three slices.
  [`store.ts:37`](../../../../src/store/store.ts#L37)

**UI: the presence widget (FR-16, FR-17, FR-18)**

- Own identity is local component state only, optimistic on submit — never written to the presence slice (AD-17).
  [`PresencePanel.tsx:60`](../../../../src/ui/widgets/presence/PresencePanel.tsx#L60)

- Code-review patch: re-registering re-sends the current viewing selection, since a fresh identity otherwise reads as `viewingTruckId: null` to every peer.
  [`PresencePanel.tsx:77`](../../../../src/ui/widgets/presence/PresencePanel.tsx#L77)

- The viewing `<select>`'s explicit "None" maps to `sendViewing(null)` — FR-18's mandated clear, not an omission.
  [`PresencePanel.tsx:85`](../../../../src/ui/widgets/presence/PresencePanel.tsx#L85)

- Subscribes to raw store records and derives sorted arrays via `useMemo`, avoiding the fresh-array-every-render trap.
  [`PresencePanel.tsx:42`](../../../../src/ui/widgets/presence/PresencePanel.tsx#L42)

- One `registerWidget` call — the whole AD-6 contract for adding this widget.
  [`PresencePanel.tsx:148`](../../../../src/ui/widgets/presence/PresencePanel.tsx#L148)

- The sole line touched to mount it — `FleetOverview.tsx` stays untouched (AD-6).
  [`App.tsx:14`](../../../../src/app/App.tsx#L14)

**Peripherals — tests**

- The three FR-19 mandated cases plus reset/rebuild, in isolation from the rest of the store.
  [`presenceSlice.test.ts`](../../../../src/store/slices/presenceSlice.test.ts)

- End-to-end presence wiring through a fake `WebSocket`: register-before-open, reconnect rebuild, the staleness-tick sweep.
  [`bootstrap.test.ts`](../../../../src/app/bootstrap.test.ts)

- `register()`'s three states (before-open, already-open, survives-reconnect), the facade singleton, and the code-review patch's `register('')` no-op guard.
  [`ws-manager.test.ts`](../../../../src/transport/ws-manager.test.ts)

- The scheduler's third buffer coalescing alongside telemetry/obs in one commit.
  [`store.test.ts`](../../../../src/store/store.test.ts)

- Widget-level render assertions, including the empty-facade, live-removal, and code-review patch's re-register-preserves-viewing cases.
  [`PresencePanel.test.tsx`](../../../../src/ui/widgets/presence/PresencePanel.test.tsx)

- Proves the shell mounts the widget through its own side-effect import.
  [`App.test.tsx`](../../../../src/app/App.test.tsx)
