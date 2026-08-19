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

import { createApiClient } from '../transport/api-client.ts'
import { createSseManager } from '../transport/sse-manager.ts'
import { createWsManager, setWsSendFacade } from '../transport/ws-manager.ts'
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

function startInitialFleetFetch(
  store: UseBoundStore<StoreApi<FleetPulseStore>>,
  getDispatcherId: () => string | null,
): void {
  const apiClient = createApiClient({ getDispatcherId })
  // Fire-and-forget from the caller's point of view: the store update is
  // the only observable effect, and both branches (ok/error) are handled —
  // nothing here can produce an unhandled rejection.
  void apiClient.getFleet().then((result) => {
    if (result.ok) store.getState().setFleet(result.data)
    else store.getState().setFleetFetchFailed()
  })
}

/** Routes each recognized WS message this story owns into the presence
 * slice. Every other recognized type (route/alert/reset events) is a
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
  const wsManager = createWsManager({
    onMessage: (msg) => handlePresenceMessage(store, scheduler, msg),
    // AD-8: the presence slice clears before the server's replay-on-
    // register rebuilds it fresh — fires on every successful connection,
    // including reconnects (FR-27's "presence state rebuilds").
    onConnect: () => store.getState().resetPresence(),
  })
  // `ui/`'s only legal reach into transport/ws-manager (AD-1's widened
  // facade) — narrowed to exactly {register, sendViewing} rather than
  // handing out the full manager.
  setWsSendFacade({ register: wsManager.register, sendViewing: wsManager.sendViewing })

  sseManager.connect()
  wsManager.connect() // eager, no blocking gate — mirrors sseManager.connect()
  startInitialFleetFetch(store, wsManager.getDispatcherId)
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
