// FleetPulse — the one Zustand store + coalescing commit scheduler (AD-5)
//
// All pipeline output lands through one coalescing commit, ceiling
// `RENDER_COALESCE_MAX_COMMITS_PER_SEC`. `createCoalescingCommitScheduler`
// is the seam a later story's `app/` wires pipeline's `onCommit`/`onAnomaly`
// callbacks into (this story proves it correct via direct injection in its
// own tests — mirrors the pipeline's own not-yet-built-consumer seam).
//
// Slices this story owns: telemetry and obs. `health` was a minimal scaffold
// until story 9 populated it for real (AD-9). `fleet` is story 1.5's roster
// slice (Design Notes deferral from story 1.4). `routes`/`presence` were
// added by later stories. `selection` (story 9) is the small cross-widget
// seam `FleetOverview`'s roster click and `VehicleDetail` share.

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'
import { createTelemetrySlice, applyTelemetryCommitsPure, type TelemetrySlice } from './slices/telemetrySlice.ts'
import { createObsSlice, pushAnomaliesPure, type ObsSlice } from './slices/obsSlice.ts'
import { createHealthSlice, type HealthSlice } from './slices/healthSlice.ts'
import { createFleetSlice, type FleetSlice } from './slices/fleetSlice.ts'
import { createPresenceSlice, applyPresenceViewingPure, type PresenceSlice, type PresenceViewingUpdate } from './slices/presenceSlice.ts'
import { createRoutesSlice, type RoutesSlice } from './slices/routesSlice.ts'
import { createSelectionSlice, type SelectionSlice } from './slices/selectionSlice.ts'
import type { PipelineCommit } from '../pipeline/index.ts'
import type { AnomalyEntry } from '../pipeline/types.ts'

export type FleetPulseStore = TelemetrySlice & ObsSlice & HealthSlice & FleetSlice & PresenceSlice & RoutesSlice & SelectionSlice

/** The store factory. Tests call this directly for per-test isolation
 * (a fresh, unshared instance every time). Production code should not call
 * this itself — use `getFleetPulseStore()` below, the one memoized
 * production instance (AD-1: `ui/` reaches it only via selectors/actions,
 * never by reaching into store internals). */
export function createFleetPulseStore(): UseBoundStore<StoreApi<FleetPulseStore>> {
  return create<FleetPulseStore>()((...args) => ({
    ...createTelemetrySlice(...args),
    ...createObsSlice(...args),
    ...createHealthSlice(...args),
    ...createFleetSlice(...args),
    ...createPresenceSlice(...args),
    ...createRoutesSlice(...args),
    ...createSelectionSlice(...args),
  }))
}

let singletonStore: UseBoundStore<StoreApi<FleetPulseStore>> | null = null

/**
 * The one production store instance (AD-5: "the Zustand store is the only
 * client source of truth" — singular). Lazily created on first call and
 * memoized for the lifetime of the page. `app/`'s composition root is what
 * triggers the actual construction (by being the first caller during
 * bootstrap, where it also builds the coalescing scheduler around this same
 * instance); `ui/` widgets call this same accessor to subscribe via
 * selectors without ever importing `app/` (AD-1: `ui/` imports only
 * `store/`). Whichever module happens to call it first is harmless — it's
 * pure memoization, not initialization order-sensitive. Tests use
 * `createFleetPulseStore()` instead, for per-test isolation.
 */
export function getFleetPulseStore(): UseBoundStore<StoreApi<FleetPulseStore>> {
  if (!singletonStore) singletonStore = createFleetPulseStore()
  return singletonStore
}

export interface CoalescingCommitScheduler {
  /** Enqueues one pipeline commit; schedules (but does not force) a flush. */
  ingestPipelineCommit(commit: PipelineCommit): void
  /** Enqueues a batch of anomaly entries; no-op for an empty array. */
  ingestAnomalies(entries: AnomalyEntry[]): void
  /** Enqueues one `dispatcher_viewing` update — the third pending buffer
   * (Boundaries & Constraints), merged into the same flush as pipeline
   * commits and anomalies via `applyPresenceViewingPure`. */
  ingestPresenceViewing(update: PresenceViewingUpdate): void
  /** Test-only: flushes immediately, bypassing the scheduled timer. */
  flushNow(): void
}

export interface CreateCoalescingCommitSchedulerOptions {
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

/**
 * One coalescing scheduler per store: buffers pipeline commits and anomaly
 * batches, flushing at most once per `1000 / RENDER_COALESCE_MAX_COMMITS_PER_SEC`
 * ms into a single `set()` call spanning both the telemetry and obs slices
 * (AD-5's "one coalescing commit" — not one `set()` per slice per flush).
 * Trailing-edge throttle, not debounce: the first enqueue in an idle period
 * schedules the one flush timer; every enqueue before it fires just adds to
 * the pending buffers rather than pushing the deadline out — a continuous
 * flood still flushes on a fixed cadence instead of being coalesced forever.
 */
export function createCoalescingCommitScheduler(
  store: Pick<StoreApi<FleetPulseStore>, 'getState' | 'setState'>,
  options: CreateCoalescingCommitSchedulerOptions = {},
): CoalescingCommitScheduler {
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
  const intervalMs = 1000 / CLIENT_THRESHOLDS.RENDER_COALESCE_MAX_COMMITS_PER_SEC

  let pendingCommits: PipelineCommit[] = []
  let pendingAnomalies: AnomalyEntry[] = []
  let pendingViewingUpdates: PresenceViewingUpdate[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    flushTimer = null
    if (pendingCommits.length === 0 && pendingAnomalies.length === 0 && pendingViewingUpdates.length === 0) return
    const commits = pendingCommits
    const anomalies = pendingAnomalies
    const viewingUpdates = pendingViewingUpdates
    pendingCommits = []
    pendingAnomalies = []
    pendingViewingUpdates = []
    store.setState((state) => ({
      telemetry: applyTelemetryCommitsPure(state.telemetry, commits),
      obs: pushAnomaliesPure(state.obs, anomalies),
      presence: applyPresenceViewingPure(state.presence, viewingUpdates),
    }))
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return
    flushTimer = setTimeoutImpl(flush, intervalMs)
  }

  return {
    ingestPipelineCommit(commit) {
      pendingCommits.push(commit)
      scheduleFlush()
    },
    ingestAnomalies(entries) {
      if (entries.length === 0) return
      pendingAnomalies.push(...entries)
      scheduleFlush()
    },
    ingestPresenceViewing(update) {
      pendingViewingUpdates.push(update)
      scheduleFlush()
    },
    flushNow() {
      if (flushTimer !== null) {
        clearTimeoutImpl(flushTimer)
        flushTimer = null
      }
      flush()
    },
  }
}
