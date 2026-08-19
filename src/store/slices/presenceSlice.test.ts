// FleetPulse — presence slice tests (FR-16..19)
//
// Node environment — no React/DOM, same convention as
// store/slices/obsSlice.test.ts and store/slices/telemetrySlice.test.ts.
// Drives the slice directly via `createFleetPulseStore()` for per-test
// isolation, mirroring store.test.ts's own harness.

import { describe, expect, it } from 'vitest'
import { createFleetPulseStore } from '../store.ts'
import { applyPresenceViewingPure, selectOtherDispatchers } from './presenceSlice.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'

describe('presenceSlice', () => {
  it('FR-19 (mandated): two dispatchers sharing a name are two distinct entries, keyed by dispatcherId', () => {
    const store = createFleetPulseStore()
    store.getState().dispatcherJoined('dispatcher_1', 'Dana', 0)
    store.getState().dispatcherJoined('dispatcher_2', 'Dana', 0)

    const others = selectOtherDispatchers(store.getState())
    expect(others).toHaveLength(2)
    expect(others.map((d) => d.dispatcherId).sort()).toEqual(['dispatcher_1', 'dispatcher_2'])
    expect(others.every((d) => d.name === 'Dana')).toBe(true)
  })

  it('FR-19 (mandated): a disconnect arriving late, duplicated, or for an already-removed id is a silent no-op — the entry is removed exactly once', () => {
    const store = createFleetPulseStore()
    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 0)
    store.getState().dispatcherJoined('dispatcher_2', 'Bob', 0)

    // First dispatcher_left removes exactly the named entry.
    store.getState().dispatcherLeft('dispatcher_1')
    expect(selectOtherDispatchers(store.getState()).map((d) => d.dispatcherId)).toEqual(['dispatcher_2'])

    // A duplicate/late dispatcher_left for the same (already-removed) id
    // never throws and never touches the remaining entry.
    expect(() => store.getState().dispatcherLeft('dispatcher_1')).not.toThrow()
    expect(selectOtherDispatchers(store.getState())).toHaveLength(1)

    // dispatcher_left for an id that was never registered — also a no-op.
    expect(() => store.getState().dispatcherLeft('dispatcher_unknown')).not.toThrow()
    expect(selectOtherDispatchers(store.getState())).toHaveLength(1)
    expect(selectOtherDispatchers(store.getState())[0]?.dispatcherId).toBe('dispatcher_2')
  })

  it('FR-19 (mandated): a presence entry silent for PRESENCE_LIVENESS_TIMEOUT_MS is swept — a live one survives', () => {
    const store = createFleetPulseStore()
    store.getState().dispatcherJoined('dispatcher_stale', 'Ghost', 0)
    store.getState().dispatcherJoined('dispatcher_live', 'Live', 0)

    // Refresh the live one's lastSeenAt via a viewing update, same as a
    // real dispatcher_viewing broadcast would (Boundaries & Constraints).
    store.getState().applyDispatcherViewing('dispatcher_live', 'truck_1', CLIENT_THRESHOLDS.PRESENCE_LIVENESS_TIMEOUT_MS - 1)

    store.getState().sweepStalePresence(CLIENT_THRESHOLDS.PRESENCE_LIVENESS_TIMEOUT_MS + 1)

    const others = selectOtherDispatchers(store.getState())
    expect(others.map((d) => d.dispatcherId)).toEqual(['dispatcher_live'])
  })

  it('does not sweep an entry seen exactly at the threshold boundary (strictly-greater-than eviction)', () => {
    const store = createFleetPulseStore()
    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 0)
    store.getState().sweepStalePresence(CLIENT_THRESHOLDS.PRESENCE_LIVENESS_TIMEOUT_MS)
    expect(selectOtherDispatchers(store.getState())).toHaveLength(1)
  })

  it('FR-18: an explicit viewing clear (truckId: null) updates the entry; an unknown/removed id is silently dropped', () => {
    const store = createFleetPulseStore()
    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 0)
    store.getState().applyDispatcherViewing('dispatcher_1', 'truck_3', 100)
    expect(selectOtherDispatchers(store.getState())[0]?.viewingTruckId).toBe('truck_3')

    store.getState().applyDispatcherViewing('dispatcher_1', null, 200)
    expect(selectOtherDispatchers(store.getState())[0]?.viewingTruckId).toBeNull()
    expect(selectOtherDispatchers(store.getState())[0]?.lastSeenAt).toBe(200)

    // A viewing update for an id that isn't present is a no-op, not a crash
    // and not a phantom entry.
    expect(() => store.getState().applyDispatcherViewing('dispatcher_ghost', 'truck_1', 300)).not.toThrow()
    expect(selectOtherDispatchers(store.getState())).toHaveLength(1)
  })

  it('applyPresenceViewingPure: pure reducer batches multiple updates, dropping unknown ids and returning the same reference when nothing changes', () => {
    const store = createFleetPulseStore()
    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 0)
    const before = store.getState().presence

    const afterEmpty = applyPresenceViewingPure(before, [])
    expect(afterEmpty).toBe(before) // no-op short-circuit, no new reference

    const afterUnknownOnly = applyPresenceViewingPure(before, [{ dispatcherId: 'dispatcher_ghost', truckId: 'truck_1', now: 10 }])
    expect(afterUnknownOnly).toBe(before) // every update dropped -> same reference

    const after = applyPresenceViewingPure(before, [
      { dispatcherId: 'dispatcher_ghost', truckId: 'truck_9', now: 10 }, // dropped
      { dispatcherId: 'dispatcher_1', truckId: 'truck_5', now: 42 },
    ])
    expect(after).not.toBe(before)
    expect(after.dispatchers['dispatcher_1']?.viewingTruckId).toBe('truck_5')
    expect(after.dispatchers['dispatcher_1']?.lastSeenAt).toBe(42)
  })

  it('AD-8: resetPresence wipes the whole slice — the seam onConnect uses before the server replay rebuilds it', () => {
    const store = createFleetPulseStore()
    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 0)
    store.getState().dispatcherJoined('dispatcher_2', 'Bob', 0)
    expect(selectOtherDispatchers(store.getState())).toHaveLength(2)

    store.getState().resetPresence()
    expect(selectOtherDispatchers(store.getState())).toHaveLength(0)

    // Rebuild: the server replays dispatcher_joined for everyone still
    // present after a reconnect.
    store.getState().dispatcherJoined('dispatcher_2', 'Bob', 1_000)
    expect(selectOtherDispatchers(store.getState()).map((d) => d.dispatcherId)).toEqual(['dispatcher_2'])
  })

  it('dispatcherJoined preserves an existing viewingTruckId when re-joining under the same id (e.g. replay), refreshing only lastSeenAt', () => {
    const store = createFleetPulseStore()
    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 0)
    store.getState().applyDispatcherViewing('dispatcher_1', 'truck_2', 50)

    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 999)
    const entry = selectOtherDispatchers(store.getState())[0]
    expect(entry?.viewingTruckId).toBe('truck_2')
    expect(entry?.lastSeenAt).toBe(999)
  })
})
