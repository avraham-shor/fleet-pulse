// FleetPulse — routes slice tests (FR-10..15, AD-16)
//
// Node environment — no React/DOM, same convention as presenceSlice.test.ts
// and obsSlice.test.ts. Drives the slice directly via
// `createFleetPulseStore()` for per-test isolation.

import { describe, expect, it } from 'vitest'
import { createFleetPulseStore } from '../store.ts'
import { selectRoutes, selectAuditTrail, selectRouteForTruck } from './routesSlice.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import type { Route } from '../../contract/rest.ts'

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    routeId: 'route_1',
    truckId: 'truck_1',
    status: 'assigned',
    version: 1,
    destination: 'Warehouse A',
    createdBy: { dispatcherId: 'dispatcher_1', name: 'Alice' },
    createdAt: 1_000,
    updatedAt: 1_000,
    updatedBy: { dispatcherId: 'dispatcher_1', name: 'Alice' },
    ...overrides,
  }
}

describe('routesSlice', () => {
  it('FR-10: applyRouteAssigned writes a new route into the slice and appends one audit row', () => {
    const store = createFleetPulseStore()
    store.getState().applyRouteAssigned(makeRoute())

    expect(selectRoutes(store.getState())).toEqual([makeRoute()])
    const trail = selectAuditTrail(store.getState())
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({ routeId: 'route_1', truckId: 'truck_1', status: 'assigned', version: 1, eventType: 'assigned' })
  })

  it('AD-16 (mandated): an echo whose version <= the currently stored version is a silently-dropped no-op', () => {
    const store = createFleetPulseStore()
    store.getState().applyRouteAssigned(makeRoute({ version: 3, status: 'assigned' }))

    // Same version, different payload — must not overwrite.
    store.getState().applyRouteUpdated(makeRoute({ version: 3, status: 'completed' }))
    expect(selectRoutes(store.getState())[0]?.status).toBe('assigned')
    expect(selectAuditTrail(store.getState())).toHaveLength(1) // no new audit row for the dropped echo

    // Lower version — also dropped.
    store.getState().applyRouteUpdated(makeRoute({ version: 2, status: 'cancelled' }))
    expect(selectRoutes(store.getState())[0]?.status).toBe('assigned')
    expect(selectAuditTrail(store.getState())).toHaveLength(1)

    // A strictly higher version is accepted.
    store.getState().applyRouteUpdated(makeRoute({ version: 4, status: 'in-progress' }))
    expect(selectRoutes(store.getState())[0]?.status).toBe('in-progress')
    expect(selectAuditTrail(store.getState())).toHaveLength(2)
  })

  it('FR-14: applyRouteReassigned overwrites the route and tags the audit row "reassigned"', () => {
    const store = createFleetPulseStore()
    store.getState().applyRouteAssigned(makeRoute({ version: 1, truckId: 'truck_1' }))
    store.getState().applyRouteReassigned(makeRoute({ version: 2, truckId: 'truck_2' }))

    expect(selectRoutes(store.getState())[0]?.truckId).toBe('truck_2')
    const trail = selectAuditTrail(store.getState())
    expect(trail[0]).toMatchObject({ eventType: 'reassigned', truckId: 'truck_2', version: 2 })
  })

  it('FR-15: selectAuditTrail returns newest-first', () => {
    const store = createFleetPulseStore()
    store.getState().applyRouteAssigned(makeRoute({ version: 1, updatedAt: 1_000 }))
    store.getState().applyRouteUpdated(makeRoute({ version: 2, updatedAt: 2_000, status: 'in-progress' }))
    store.getState().applyRouteUpdated(makeRoute({ version: 3, updatedAt: 3_000, status: 'completed' }))

    const trail = selectAuditTrail(store.getState())
    expect(trail.map((entry) => entry.version)).toEqual([3, 2, 1])
  })

  it('NFR-3: the audit trail never exceeds AUDIT_TRAIL_CAP', () => {
    const store = createFleetPulseStore()
    const cap = CLIENT_THRESHOLDS.AUDIT_TRAIL_CAP
    store.getState().applyRouteAssigned(makeRoute({ version: 1, updatedAt: 0 }))
    for (let i = 0; i < cap + 20; i++) {
      store.getState().applyRouteUpdated(makeRoute({ version: i + 2, updatedAt: i + 1, status: 'in-progress' }))
    }
    expect(store.getState().routes.auditTrail.size()).toBe(cap)
  })

  it('selectRoutes sorts truckId-ascending (numeric-aware), tie-broken by routeId', () => {
    const store = createFleetPulseStore()
    store.getState().applyRouteAssigned(makeRoute({ routeId: 'route_a', truckId: 'truck_10' }))
    store.getState().applyRouteAssigned(makeRoute({ routeId: 'route_b', truckId: 'truck_2' }))
    store.getState().applyRouteAssigned(makeRoute({ routeId: 'route_c', truckId: 'truck_2', updatedAt: 999 }))

    const ids = selectRoutes(store.getState()).map((route) => route.truckId)
    expect(ids).toEqual(['truck_2', 'truck_2', 'truck_10'])
  })

  it('applyRouteAssigned is safe to replay for a route that already exists at the same version (hydration idempotency)', () => {
    const store = createFleetPulseStore()
    const route = makeRoute({ version: 2, status: 'in-progress' })
    store.getState().applyRouteAssigned(route)
    expect(() => store.getState().applyRouteAssigned(route)).not.toThrow()
    expect(selectRoutes(store.getState())).toHaveLength(1)
    expect(selectAuditTrail(store.getState())).toHaveLength(1) // the replay never appended a second row
  })

  it('FR-23: selectRouteForTruck finds the truck\'s assigned/in-progress route, ignoring terminal ones', () => {
    const store = createFleetPulseStore()
    store.getState().applyRouteAssigned(makeRoute({ routeId: 'route_old', truckId: 'truck_1', version: 1, status: 'cancelled' }))
    store.getState().applyRouteAssigned(makeRoute({ routeId: 'route_active', truckId: 'truck_1', version: 1, status: 'assigned' }))

    expect(selectRouteForTruck(store.getState(), 'truck_1')?.routeId).toBe('route_active')
  })

  it('selectRouteForTruck reads null when the truck has no active route (FR-23 empty state)', () => {
    const store = createFleetPulseStore()
    expect(selectRouteForTruck(store.getState(), 'truck_9')).toBeNull()

    store.getState().applyRouteAssigned(makeRoute({ truckId: 'truck_9', status: 'completed' }))
    expect(selectRouteForTruck(store.getState(), 'truck_9')).toBeNull()
  })

  it('FR-33: resetRoutes wipes the route map but leaves the audit trail intact', () => {
    const store = createFleetPulseStore()
    store.getState().applyRouteAssigned(makeRoute())
    expect(selectRoutes(store.getState())).toHaveLength(1)
    expect(selectAuditTrail(store.getState())).toHaveLength(1)

    store.getState().resetRoutes()

    expect(selectRoutes(store.getState())).toEqual([])
    expect(selectAuditTrail(store.getState())).toHaveLength(1) // audit trail survives (not in this story's wipe list)
  })

  it('resetRoutes is safe to re-populate afterward (the re-hydration half of fleet_reset)', () => {
    const store = createFleetPulseStore()
    store.getState().applyRouteAssigned(makeRoute({ version: 5 }))
    store.getState().resetRoutes()
    // A route re-arriving (e.g. from a post-reset GET /api/routes hydration)
    // at a version <= the one this slice already forgot must not be
    // rejected as a stale echo — the guard compares against the *current*
    // (now-empty) map, not history.
    store.getState().applyRouteAssigned(makeRoute({ version: 1 }))
    expect(selectRoutes(store.getState())).toHaveLength(1)
    expect(selectRoutes(store.getState())[0]?.version).toBe(1)
  })
})
