// FleetPulse — composition root: wiring only (AD-1)
//
// The sole bridge from transport lifecycle into pipeline/store: constructs
// every transport/pipeline/store/scheduler instance this story needs,
// wires pipeline output into the coalescing scheduler, wires the SSE
// manager's frames into the pipeline, fetches the initial 12-truck roster
// once (SSE delivers deltas only), and starts the one `STALENESS_TICK_MS`
// interval the effective-trust selector depends on (AD-3). Nothing above
// `app/` constructs any of these directly.
//
// This story never opens the WS connection or touches presence (story
// 1.6's job) — `getDispatcherId` is permanently `() => null` here: `getFleet()`
// is not a mutation and never reads it, so there is nothing to wire yet.
//
// `getBootstrap()` is memoized at module scope so React 19 StrictMode's
// dev-only double-invoke of effects (mount -> cleanup -> mount) never opens
// a second SSE connection or fires a second `getFleet()` — the actual
// wiring in `createBootstrap()` below runs at most once per page load.

import { createApiClient } from '../transport/api-client.ts'
import { createSseManager } from '../transport/sse-manager.ts'
import { createPipeline } from '../pipeline/index.ts'
import { createCoalescingCommitScheduler, getFleetPulseStore, type FleetPulseStore } from '../store/store.ts'
import { tickEffectiveTrust } from '../store/selectors/effectiveTrust.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'
import type { StoreApi, UseBoundStore } from 'zustand'

export interface Bootstrap {
  store: UseBoundStore<StoreApi<FleetPulseStore>>
}

let bootstrap: Bootstrap | null = null
let stalenessIntervalId: ReturnType<typeof setInterval> | null = null

function startInitialFleetFetch(store: UseBoundStore<StoreApi<FleetPulseStore>>): void {
  const apiClient = createApiClient({ getDispatcherId: () => null })
  // Fire-and-forget from the caller's point of view: the store update is
  // the only observable effect, and both branches (ok/error) are handled —
  // nothing here can produce an unhandled rejection.
  void apiClient.getFleet().then((result) => {
    if (result.ok) store.getState().setFleet(result.data)
    else store.getState().setFleetFetchFailed()
  })
}

function createBootstrap(): Bootstrap {
  const store = getFleetPulseStore()
  const scheduler = createCoalescingCommitScheduler(store)
  const pipeline = createPipeline({
    onCommit: scheduler.ingestPipelineCommit,
    onAnomaly: scheduler.ingestAnomalies,
  })
  const sseManager = createSseManager({ onBatch: pipeline.ingest })

  sseManager.connect()
  startInitialFleetFetch(store)
  stalenessIntervalId = setInterval(() => tickEffectiveTrust(store.getState()), CLIENT_THRESHOLDS.STALENESS_TICK_MS)

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
