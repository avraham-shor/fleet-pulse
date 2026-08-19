// FleetPulse — the one Zustand store + coalescing commit scheduler (AD-5)
//
// All pipeline output lands through one coalescing commit, ceiling
// `RENDER_COALESCE_MAX_COMMITS_PER_SEC`. `createCoalescingCommitScheduler`
// is the seam a later story's `app/` wires pipeline's `onCommit`/`onAnomaly`
// callbacks into (this story proves it correct via direct injection in its
// own tests — mirrors the pipeline's own not-yet-built-consumer seam).
//
// Slices this story owns: telemetry and obs. `health` is the minimal
// scaffold story 1.9 populates for real. `fleet`/`routes`/`presence` are
// later stories' slices — not created here.

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'
import { createTelemetrySlice, applyTelemetryCommitsPure, type TelemetrySlice } from './slices/telemetrySlice.ts'
import { createObsSlice, pushAnomaliesPure, type ObsSlice } from './slices/obsSlice.ts'
import { createHealthSlice, type HealthSlice } from './slices/healthSlice.ts'
import type { PipelineCommit } from '../pipeline/index.ts'
import type { AnomalyEntry } from '../pipeline/types.ts'

export type FleetPulseStore = TelemetrySlice & ObsSlice & HealthSlice

/** The one store this story creates. A later story's `app/` is the only
 * place allowed to import this directly outside tests (AD-1: `ui/` reaches
 * it only via selectors/actions, never by importing `store.ts` and reaching
 * into internals). */
export function createFleetPulseStore(): UseBoundStore<StoreApi<FleetPulseStore>> {
  return create<FleetPulseStore>()((...args) => ({
    ...createTelemetrySlice(...args),
    ...createObsSlice(...args),
    ...createHealthSlice(...args),
  }))
}

export interface CoalescingCommitScheduler {
  /** Enqueues one pipeline commit; schedules (but does not force) a flush. */
  ingestPipelineCommit(commit: PipelineCommit): void
  /** Enqueues a batch of anomaly entries; no-op for an empty array. */
  ingestAnomalies(entries: AnomalyEntry[]): void
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
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    flushTimer = null
    if (pendingCommits.length === 0 && pendingAnomalies.length === 0) return
    const commits = pendingCommits
    const anomalies = pendingAnomalies
    pendingCommits = []
    pendingAnomalies = []
    store.setState((state) => ({
      telemetry: applyTelemetryCommitsPure(state.telemetry, commits),
      obs: pushAnomaliesPure(state.obs, anomalies),
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
    flushNow() {
      if (flushTimer !== null) {
        clearTimeoutImpl(flushTimer)
        flushTimer = null
      }
      flush()
    },
  }
}
