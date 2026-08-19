// FleetPulse — composition root: wiring only (AD-1)
//
// The sole bridge from transport lifecycle into pipeline/store: constructs
// every transport/pipeline/store/scheduler instance this story needs,
// wires pipeline output into the coalescing scheduler, wires the SSE
// manager's frames into the pipeline, wires the WS manager's presence
// events into the presence slice (dispatcher_joined/_left commit directly;
// dispatcher_viewing rides the same coalescing scheduler, AD-5), fetches
// the initial 12-truck roster once (SSE delivers deltas only), and starts
// the one `STALENESS_TICK_MS` interval that both re-evaluates the
// effective-trust selector (AD-3) and sweeps stale presence entries
// (FR-19's liveness rule, piggybacked on the same tick). Nothing above
// `app/` constructs any of these directly.
//
// `wsManager` connects eagerly, same as `sseManager` — no blocking gate
// (Boundaries & Constraints). `getDispatcherId` now reads the WS manager's
// live session-scoped identity (AD-17) instead of the story-1.5 stub.
//
// `getBootstrap()` is memoized at module scope so React 19 StrictMode's
// dev-only double-invoke of effects (mount -> cleanup -> mount) never opens
// a second SSE/WS connection or fires a second `getFleet()` — the actual
// wiring in `createBootstrap()` below runs at most once per page load.

import { createApiClient, type ApiClient } from '../transport/api-client.ts'
import { createSseManager } from '../transport/sse-manager.ts'
import { createWsManager, setWsSendFacade, type WsManager } from '../transport/ws-manager.ts'
import type { ServerWsMessage } from '../contract/ws-server.ts'
import { createPipeline } from '../pipeline/index.ts'
import { createCoalescingCommitScheduler, getFleetPulseStore, type CoalescingCommitScheduler, type FleetPulseStore } from '../store/store.ts'
import { tickEffectiveTrust } from '../store/selectors/effectiveTrust.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'
import type { StoreApi, UseBoundStore } from 'zustand'

export interface Bootstrap {
  store: UseBoundStore<StoreApi<FleetPulseStore>>
}

let bootstrap: Bootstrap | null = null
let stalenessIntervalId: ReturnType<typeof setInterval> | null = null

function startInitialFleetFetch(store: UseBoundStore<StoreApi<FleetPulseStore>>, apiClient: ApiClient): void {
  // Fire-and-forget from the caller's point of view: the store update is
  // the only observable effect, and both branches (ok/error) are handled —
  // nothing here can produce an unhandled rejection.
  void apiClient.getFleet().then((result) => {
    if (result.ok) store.getState().setFleet(result.data)
    else store.getState().setFleetFetchFailed()
  })
}

/** FR-34's hydration gap fix (Spec Change Log iteration 1, corrected
 * iteration 2/3): the WS protocol never replays route state on
 * register/reconnect (only presence is replayed, server.js:742-752), so
 * `GET /api/routes` is the only way a client learns about a route that
 * existed before its current connection — otherwise the create-route
 * warn-and-confirm would silently fail to fire for a truck whose active
 * route predates the session. Goes through `apiClient.getRoutes()`
 * (AD-7 — never a raw `fetch`), applying each returned route via the same
 * monotonic-write action live echoes use (`applyRouteAssigned` — the
 * guard's idempotent, so replaying an already-known route is a safe
 * no-op); this keeps AD-16's "WS echo is the sole writer" framing intact,
 * since hydration feeds the identical write path rather than adding a
 * second one. Best-effort: a non-ok result does nothing further — no error
 * UI, no retry — the slice just catches up from the next live echo. */
async function hydrateRoutes(store: UseBoundStore<StoreApi<FleetPulseStore>>, apiClient: ApiClient): Promise<void> {
  const result = await apiClient.getRoutes()
  if (!result.ok) return
  for (const route of result.data) {
    store.getState().applyRouteAssigned(route)
  }
}

/** Routes each recognized WS message this story owns into the presence and
 * routes slices. Every other recognized type (alert/reset events) is a
 * future story's concern — safely ignored here rather than crashing
 * (FR-33: unknown-to-*this*-wiring messages never break the UI). */
function handlePresenceMessage(
  store: UseBoundStore<StoreApi<FleetPulseStore>>,
  scheduler: CoalescingCommitScheduler,
  msg: ServerWsMessage,
): void {
  switch (msg.type) {
    case 'dispatcher_joined':
      store.getState().dispatcherJoined(msg.dispatcherId, msg.name)
      return
    case 'dispatcher_left':
      store.getState().dispatcherLeft(msg.dispatcherId)
      return
    case 'dispatcher_viewing':
      scheduler.ingestPresenceViewing({ dispatcherId: msg.dispatcherId, truckId: msg.truckId, now: Date.now() })
      return
    // Route events are low-rate, direct-commit writes (AD-16) — never
    // routed through the coalescing scheduler, same as dispatcher_joined/
    // _left above.
    case 'route_assigned':
      store.getState().applyRouteAssigned(msg.route)
      return
    case 'route_updated':
      store.getState().applyRouteUpdated(msg.route)
      return
    case 'route_reassigned':
      store.getState().applyRouteReassigned(msg.route)
      return
    default:
      return
  }
}

function createBootstrap(): Bootstrap {
  const store = getFleetPulseStore()
  const scheduler = createCoalescingCommitScheduler(store)
  const pipeline = createPipeline({
    onCommit: scheduler.ingestPipelineCommit,
    onAnomaly: scheduler.ingestAnomalies,
  })
  const sseManager = createSseManager({ onBatch: pipeline.ingest })

  // Forward-referenced: `apiClient`'s `getDispatcherId` reads this live on
  // every call (AD-17), but `wsManager` itself needs an `onConnect`
  // callback (which calls `hydrateRoutes()`, which needs `apiClient`)
  // before it can be constructed. `wsManager` is assigned immediately after
  // `createWsManager()` returns, before either callback can actually fire.
  let wsManager: WsManager | undefined
  const apiClient = createApiClient({ getDispatcherId: () => wsManager?.getDispatcherId() ?? null })

  wsManager = createWsManager({
    onMessage: (msg) => handlePresenceMessage(store, scheduler, msg),
    onConnect: () => {
      // AD-8: the presence slice clears before the server's replay-on-
      // register rebuilds it fresh — fires on every successful connection,
      // including reconnects (FR-27's "presence state rebuilds").
      store.getState().resetPresence()
      // FR-34's hydration gap fix (Spec Change Log iteration 3): called
      // from exactly this one place — `onConnect` already fires once per
      // successful connection, including the first, so a separate
      // bootstrap-time call would double-fire on every page load. Mirrors
      // `resetPresence()`'s own single call site, immediately above.
      void hydrateRoutes(store, apiClient)
    },
  })
  // `ui/`'s only legal reach into transport/ws-manager (AD-1's widened
  // facade) — narrowed to {register, sendViewing, getDispatcherId} rather
  // than handing out the full manager.
  setWsSendFacade({ register: wsManager.register, sendViewing: wsManager.sendViewing, getDispatcherId: wsManager.getDispatcherId })

  sseManager.connect()
  wsManager.connect() // eager, no blocking gate — mirrors sseManager.connect()
  startInitialFleetFetch(store, apiClient)
  stalenessIntervalId = setInterval(() => {
    tickEffectiveTrust(store.getState())
    store.getState().sweepStalePresence(Date.now()) // FR-19 liveness sweep, piggybacked on this same tick
  }, CLIENT_THRESHOLDS.STALENESS_TICK_MS)

  return { store }
}

/** Idempotent: the first call performs every wiring step above; every call
 * after that (including StrictMode's extra dev-mode mount) just returns the
 * same instance with no further side effect. */
export function getBootstrap(): Bootstrap {
  if (!bootstrap) bootstrap = createBootstrap()
  return bootstrap
}

/** Test-only: drops the memoized instance so a fresh `import()` of this
 * module (paired with `vi.resetModules()`) can prove the wiring runs again
 * from a clean slate. Also clears the staleness interval — otherwise a
 * reset-then-rebootstrap cycle within the same module instance would leave
 * the prior interval still firing alongside the new one. Production code
 * never calls this. */
export function resetBootstrapForTests(): void {
  bootstrap = null
  if (stalenessIntervalId !== null) {
    clearInterval(stalenessIntervalId)
    stalenessIntervalId = null
  }
}
