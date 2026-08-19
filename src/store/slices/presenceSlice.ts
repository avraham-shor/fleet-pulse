// FleetPulse — presence slice: other active dispatchers (FR-16..19, AD-8, AD-17)
//
// Keyed only by the server-issued `dispatcherId` (FR-19) — never by name;
// two dispatchers sharing a name are two legitimate entries. This client's
// own identity never enters this slice (AD-17) — every entry here is, by
// construction, some *other* dispatcher (the widget tracks "registered as
// X" as its own local component state, never through this slice).
//
// `dispatcherJoined`/`dispatcherLeft` are low-rate direct-commit actions
// (AD-5) — `app/`'s composition root calls them straight from the WS
// manager's `onMessage`. `dispatcher_viewing` churn is higher-rate and
// rides `store.ts`'s coalescing scheduler instead, via a pending-buffer +
// pure-reducer split mirroring `obsSlice.ts`'s own `pushAnomaliesPure`
// (`obsSlice.ts:56`): `applyPresenceViewingPure` is exported so the
// scheduler can merge it into the same `set()` as telemetry/obs, and
// `applyDispatcherViewing` wraps it as a single-update direct action for
// tests and any non-batched caller.
//
// Any action naming an unknown or already-removed `dispatcherId` is a
// silent no-op (FR-19: a disconnect for an already-removed identity, or a
// late/duplicate one, never breaks the UI and never leaves phantom state).

import type { StateCreator } from 'zustand'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { FleetPulseStore } from '../store.ts'

export interface PresenceEntry {
  name: string
  viewingTruckId: string | null
  /** Arrival-clock timestamp of the most recent sign of life for this
   * entry — refreshed by `dispatcherJoined` and every viewing update
   * (Boundaries & Constraints). `sweepStalePresence` evicts an entry once
   * `now - lastSeenAt` exceeds `PRESENCE_LIVENESS_TIMEOUT_MS` (FR-19's
   * "silent vanish" case). */
  lastSeenAt: number
}

export interface PresenceState {
  dispatchers: Record<string, PresenceEntry>
}

/** One `dispatcher_viewing` update, batched by `store.ts`'s coalescing
 * scheduler before being folded into `applyPresenceViewingPure` — the
 * "third pending buffer" the Boundaries & Constraints call for. */
export interface PresenceViewingUpdate {
  dispatcherId: string
  truckId: string | null
  now: number
}

export interface PresenceSlice {
  presence: PresenceState
  /** A dispatcher registered (fresh join, or the server's replay-on-
   * register rebuild after a reconnect, AD-8) — upserts the entry and
   * refreshes `lastSeenAt`. A rename mid-shift lands here too, under a
   * fresh `dispatcherId` (Design Notes: no special-casing needed). */
  dispatcherJoined: (dispatcherId: string, name: string, now?: number) => void
  /** A dispatcher disconnected. No-op for an unknown/already-removed id —
   * covers the late/duplicate ghost-disconnect case (FR-19) without any
   * special-casing: the id is simply no longer present to delete. */
  dispatcherLeft: (dispatcherId: string) => void
  /** Single-update direct action wrapping `applyPresenceViewingPure` — for
   * tests and any caller that isn't the coalescing scheduler. */
  applyDispatcherViewing: (dispatcherId: string, truckId: string | null, now?: number) => void
  /** FR-19's liveness sweep: evicts every entry silent for longer than
   * `PRESENCE_LIVENESS_TIMEOUT_MS`. `app/` piggybacks this on the same
   * tick that drives the effective-trust selector's staleness recompute. */
  sweepStalePresence: (now: number) => void
  /** Wipes the whole slice — called on WS `onConnect` (AD-8), before the
   * server's replay-on-register rebuilds it fresh; also fleet_reset step 2
   * (AD-8's three-step reset sequence, future story's concern to trigger). */
  resetPresence: () => void
}

/** Pure reducer over presence state — mirrors `pushAnomaliesPure`'s split
 * (`obsSlice.ts:56`) so `store.ts`'s coalescing scheduler can compute the
 * next presence state without itself calling `set()`, merging it into the
 * same batched commit as telemetry/obs. An update naming an unknown or
 * already-removed `dispatcherId` is silently dropped (FR-19). */
export function applyPresenceViewingPure(
  presence: PresenceState,
  updates: readonly PresenceViewingUpdate[],
): PresenceState {
  if (updates.length === 0) return presence
  let dispatchers = presence.dispatchers
  let changed = false
  for (const update of updates) {
    const existing = dispatchers[update.dispatcherId]
    if (!existing) continue // unknown/already-removed id: silent no-op (FR-19)
    if (!changed) {
      dispatchers = { ...dispatchers }
      changed = true
    }
    dispatchers[update.dispatcherId] = { ...existing, viewingTruckId: update.truckId, lastSeenAt: update.now }
  }
  return changed ? { dispatchers } : presence
}

function createInitialPresenceState(): PresenceState {
  return { dispatchers: {} }
}

export const createPresenceSlice: StateCreator<FleetPulseStore, [], [], PresenceSlice> = (set) => ({
  presence: createInitialPresenceState(),
  dispatcherJoined: (dispatcherId, name, now = Date.now()) =>
    set((state) => ({
      presence: {
        dispatchers: {
          ...state.presence.dispatchers,
          [dispatcherId]: {
            name,
            viewingTruckId: state.presence.dispatchers[dispatcherId]?.viewingTruckId ?? null,
            lastSeenAt: now,
          },
        },
      },
    })),
  dispatcherLeft: (dispatcherId) =>
    set((state) => {
      if (!(dispatcherId in state.presence.dispatchers)) return state // silent no-op (FR-19)
      const dispatchers = { ...state.presence.dispatchers }
      delete dispatchers[dispatcherId]
      return { presence: { dispatchers } }
    }),
  applyDispatcherViewing: (dispatcherId, truckId, now = Date.now()) =>
    set((state) => ({ presence: applyPresenceViewingPure(state.presence, [{ dispatcherId, truckId, now }]) })),
  sweepStalePresence: (now) =>
    set((state) => {
      let dispatchers = state.presence.dispatchers
      let changed = false
      for (const [id, entry] of Object.entries(state.presence.dispatchers)) {
        if (now - entry.lastSeenAt > CLIENT_THRESHOLDS.PRESENCE_LIVENESS_TIMEOUT_MS) {
          if (!changed) {
            dispatchers = { ...dispatchers }
            changed = true
          }
          delete dispatchers[id]
        }
      }
      return changed ? { presence: { dispatchers } } : state
    }),
  resetPresence: () => set({ presence: createInitialPresenceState() }),
})

/** Every entry currently in the slice — by construction, always some
 * *other* dispatcher (AD-17: this client's own identity never lands here).
 * Stable render order: name, then id as a tiebreaker for two dispatchers
 * sharing a name (FR-19). */
export function selectOtherDispatchers(
  state: Pick<FleetPulseStore, 'presence'>,
): Array<{ dispatcherId: string } & PresenceEntry> {
  return Object.entries(state.presence.dispatchers)
    .map(([dispatcherId, entry]) => ({ dispatcherId, ...entry }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.dispatcherId.localeCompare(b.dispatcherId))
}
