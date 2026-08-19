// FleetPulse — composition root: wiring only (AD-1)
//
// The sole bridge from transport lifecycle into pipeline/store: constructs
// every transport/pipeline/store/scheduler instance this story needs,
// wires pipeline output into the coalescing scheduler, wires the SSE
// manager's frames into the pipeline, wires the WS manager's presence/
// route/alert events into their owning slices (dispatcher_joined/_left and
// route events commit directly; dispatcher_viewing rides the coalescing
// scheduler, AD-5), fetches the initial 12-truck roster once (SSE delivers
// deltas only), and starts the one `STALENESS_TICK_MS` interval that
// re-evaluates the effective-trust selector (AD-3), sweeps stale presence
// entries (FR-19's liveness rule), and polls the circuit breaker's state
// into the health slice (AD-9) — all piggybacked on the same tick rather
// than adding three separate intervals. Nothing above `app/` constructs
// any of these directly.
//
// `wsManager` connects eagerly, same as `sseManager` — no blocking gate
// (Boundaries & Constraints). `getDispatcherId` now reads the WS manager's
// live session-scoped identity (AD-17) instead of the story-1.5 stub.
//
// Story 9 wires the health slice's two AD-9 conditions: `sseManager`'s new
// `onConnectionChange` callback drives `telemetryStreamDown` directly
// (event-driven — up/down is known the instant it happens); `apiClient`'s
// breaker has no such callback (it's a plain polled getter, read-only from
// this story per Boundaries), so `fleetFetchFailing` is polled from
// `getBreakerState()` on the same staleness tick instead. It also wires the
// real `fleet_reset`/`truck_alert` handlers into the WS message switch,
// previously falling to `default: return`.
//
// Story 10 adds one more read on that same tick: `setTransportCounters()`,
// pulled from the three managers' already-existing read-only getters (plus
// `sseManager`'s new `getEventsPerSecond()`) into `obs.transportCounters` —
// the seam `DevMetrics` (FR-30) reads from. No new interval, no new fetch or
// subscription path (Boundaries & Constraints).
//
// `getBootstrap()` is memoized at module scope so React 19 StrictMode's
// dev-only double-invoke of effects (mount -> cleanup -> mount) never opens
// a second SSE/WS connection or fires a second `getFleet()` — the actual
// wiring in `createBootstrap()` below runs at most once per page load.

import { createApiClient, type ApiClient } from '../transport/api-client.ts'
import { createSseManager } from '../transport/sse-manager.ts'
import { createWsManager, setWsSendFacade, type WsManager } from '../transport/ws-manager.ts'
import type { ServerWsMessage } from '../contract/ws-server.ts'
import { createPipeline, type Pipeline } from '../pipeline/index.ts'
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

/** AD-8's `fleet_reset` sequence, in the exact order this story's
 * Boundaries & Constraints specify: `pipeline.reset()` (drop the pending
 * coalesce buffer, per-truck cursors, dedupe sets, open suspect windows),
 * `resetTelemetry()`, `resetObs()`, `resetFleetAlerts()` (code-review
 * finding: this story's own per-truck alert buffers are session-scoped
 * derived state too — trust-model.md documents the anomaly log as "wiped by
 * a fleet reset along with the rest of derived state," and alerts are the
 * same category — grouped here alongside `resetObs()` since both wipe a
 * bounded, session-accumulated log), a routes reset + re-hydration
 * (`resetRoutes()` then reusing `hydrateRoutes()`'s existing `GET
 * /api/routes` seam — never a second fetch path), `resetPresence()` (the
 * server re-announces current dispatchers after broadcasting `fleet_reset`,
 * AD-17, so this client rebuilds the same way a reconnect does), and
 * finally, only while the breaker is open, `forceNextProbe()` plus the one
 * `getFleet()` call that actually performs the "immediate probe" FR-33
 * promises — `forceNextProbe()` alone only clears the scheduled-probe gate,
 * it doesn't itself contact the server. */
function runFleetReset(
  store: UseBoundStore<StoreApi<FleetPulseStore>>,
  pipeline: Pipeline,
  apiClient: ApiClient,
): void {
  pipeline.reset()
  store.getState().resetTelemetry()
  store.getState().resetObs()
  store.getState().resetFleetAlerts()
  store.getState().resetRoutes()
  void hydrateRoutes(store, apiClient)
  store.getState().resetPresence()
  if (apiClient.getBreakerState() === 'open') {
    apiClient.forceNextProbe()
    void apiClient.getFleet().then((result) => {
      if (result.ok) store.getState().setFleet(result.data)
      else store.getState().setFleetFetchFailed()
    })
  }
}

/** Routes each recognized WS message into its owning slice: presence
 * (join/leave direct-commit, viewing through the coalescing scheduler),
 * routes (direct-commit, AD-16's sole-writer echo), `truck_alert` (FR-32,
 * CM1), and `fleet_reset` (AD-8, FR-33). Every other recognized-but-
 * unhandled type is safely ignored (FR-33: unknown/dev-only messages never
 * break the UI). */
function handlePresenceMessage(
  store: UseBoundStore<StoreApi<FleetPulseStore>>,
  scheduler: CoalescingCommitScheduler,
  pipeline: Pipeline,
  apiClient: ApiClient,
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
    case 'truck_alert':
      // FR-32/CM1: per-truck bounded buffer, stub-upserting an unrecognized
      // truckId — handled entirely inside `addTruckAlert` (fleetSlice.ts).
      store.getState().addTruckAlert({
        truckId: msg.truckId,
        message: msg.message,
        dispatcherId: msg.dispatcherId,
        dispatcherName: msg.dispatcherName,
        timestamp: msg.timestamp,
      })
      return
    case 'fleet_reset':
      runFleetReset(store, pipeline, apiClient)
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
  // AD-9: `telemetryStreamDown` is set directly from the SSE connection's
  // own up/down events — event-driven, not polled (contrast the breaker
  // below, which has no equivalent callback).
  const sseManager = createSseManager({
    onBatch: pipeline.ingest,
    onConnectionChange: (connected) => store.getState().setTelemetryStreamDown(!connected),
  })

  // Forward-referenced: `apiClient`'s `getDispatcherId` reads this live on
  // every call (AD-17), but `wsManager` itself needs an `onConnect`
  // callback (which calls `hydrateRoutes()`, which needs `apiClient`)
  // before it can be constructed. `wsManager` is assigned immediately after
  // `createWsManager()` returns, before either callback can actually fire.
  let wsManager: WsManager | undefined
  const apiClient = createApiClient({ getDispatcherId: () => wsManager?.getDispatcherId() ?? null })

  wsManager = createWsManager({
    onMessage: (msg) => handlePresenceMessage(store, scheduler, pipeline, apiClient, msg),
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
    // AD-9: the breaker exposes no change callback (read-only from this
    // story) — polled here, on the same 1s cadence as everything else this
    // tick already drives, rather than adding a second interval.
    store.getState().setFleetFetchFailing(apiClient.getBreakerState() === 'open')
    tickEffectiveTrust(store.getState())
    store.getState().sweepStalePresence(Date.now()) // FR-19 liveness sweep, piggybacked on this same tick
    // FR-30/story 10: transport obs counters, read (never computed) from
    // the three managers' own getters — `wsManager` is always assigned by
    // the time this interval callback can run (it fires no earlier than the
    // next tick after `createBootstrap()` finishes), the `?? ` fallbacks
    // below exist only to satisfy the forward-reference type, not because
    // the undefined branch is actually reachable in production.
    store.getState().setTransportCounters({
      sseDroppedMessages: sseManager.getDroppedMessageCount(),
      sseReconnects: sseManager.getReconnectCount(),
      sseEventsPerSecond: sseManager.getEventsPerSecond(),
      wsDroppedMessages: wsManager?.getDroppedMessageCount() ?? 0,
      wsReconnects: wsManager?.getReconnectCount() ?? 0,
      wsLastPingRttMs: wsManager?.getLastPingRttMs() ?? null,
    })
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
