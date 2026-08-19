// FleetPulse — routes slice: route state + session-scoped audit trail
// (FR-10..FR-15, AD-16)
//
// The WS route echo (route_assigned/_updated/_reassigned) is the *sole*
// writer of route state (AD-16) — api-client's 2xx never writes here, it
// only clears a mutation's local in-flight/confirm state (pessimistic UI).
// Writes are monotonic by version: a write naming a `version` <= the
// currently-stored version for that route is a silently-dropped no-op —
// this also makes `applyRouteAssigned` safe to reuse for `hydrateRoutes()`
// (bootstrap.ts), since replaying an already-known route is just another
// no-op through the same guard, not a second writer.
//
// Route echoes are low-rate, direct-commit actions (like presence
// join/leave) — never routed through store.ts's coalescing scheduler
// (Boundaries & Constraints).
//
// The audit trail is a session-scoped bounded collection (AD-10, AD-15's
// sibling deferral: "audit-trail entry shape is code-owned"), built via the
// same `createBoundedBuffer` factory obsSlice.ts's anomaly log uses,
// appended from the same three echo handlers that write `routes` — one
// audit row per accepted (non-no-op) echo, keyed by `at` (the route's own
// `updatedAt`) for ordering, capped by `CLIENT_THRESHOLDS.AUDIT_TRAIL_CAP`.
// A late joiner sees only a partial trail — accepted and documented (AD-16).

import type { StateCreator } from 'zustand'
import type { Route, RouteActor, RouteStatus } from '../../contract/rest.ts'
import { CLIENT_THRESHOLDS } from '../../../shared/constants.js'
import { createBoundedBuffer, type BoundedBuffer } from '../boundedBuffer.ts'
import type { FleetPulseStore } from '../store.ts'

/** Which WS route event produced this audit row — display-only tag, not a
 * classification of the route's resulting status (a hydrated route or a
 * plain status transition both land through `applyRouteAssigned`/
 * `applyRouteUpdated` respectively; `eventType` records which one). */
export type RouteAuditEventType = 'assigned' | 'updated' | 'reassigned'

export interface RouteAuditEntry {
  routeId: string
  truckId: string
  status: RouteStatus
  version: number
  actor: RouteActor
  /** The route's own `updatedAt` — the ordering key for the bounded buffer,
   * and what the trail renders as "when" (FR-15). */
  at: number
  eventType: RouteAuditEventType
}

export interface RoutesState {
  /** Keyed by `routeId` — every route this session has ever seen, current
   * snapshot only (not a history of every version). */
  routes: Record<string, Route>
  auditTrail: BoundedBuffer<RouteAuditEntry>
}

export interface RoutesSlice {
  routes: RoutesState
  /** `route_assigned` echo handler (FR-10) — also the write path
   * `hydrateRoutes()` reuses for every route returned by `GET /api/routes`
   * (Design Notes): the monotonic guard makes replaying an already-known
   * route a safe no-op either way. */
  applyRouteAssigned: (route: Route) => void
  /** `route_updated` echo handler (FR-11, FR-12) — status transitions,
   * including cancel (`status: 'cancelled'` is not a distinct endpoint). */
  applyRouteUpdated: (route: Route) => void
  /** `route_reassigned` echo handler (FR-14). */
  applyRouteReassigned: (route: Route) => void
  /** `fleet_reset` step (AD-8, FR-33): wipes the route map only — the
   * session-scoped `auditTrail` survives (mirrors `resetObs`'s own
   * "counters survive" convention), since nothing in this story's Boundaries
   * asks for the trail itself to be cleared. `app/bootstrap.ts` follows this
   * with `hydrateRoutes()` (the "re-hydration" half) so the slice catches
   * back up from `GET /api/routes` rather than sitting empty until the next
   * live echo. */
  resetRoutes: () => void
}

function createInitialRoutesState(): RoutesState {
  return {
    routes: {},
    auditTrail: createBoundedBuffer<RouteAuditEntry>({
      cap: CLIENT_THRESHOLDS.AUDIT_TRAIL_CAP,
      orderingKey: (entry) => entry.at,
    }),
  }
}

/** Shared core for all three echo handlers: the AD-16 monotonic-write guard
 * plus the one audit-row append every accepted write produces. Mutates
 * `state.auditTrail` in place (same convention as obsSlice.ts's
 * `pushAnomaliesPure` — the buffer instance itself never changes, only the
 * wrapper object does) and returns a fresh `RoutesState` only when the
 * write is actually accepted; returns the same `state` reference for a
 * no-op so a caller (or a test) can tell nothing changed. */
function applyRouteEcho(state: RoutesState, route: Route, eventType: RouteAuditEventType): RoutesState {
  const current = state.routes[route.routeId]
  if (current && route.version <= current.version) return state // AD-16: stale/duplicate echo, silently dropped
  state.auditTrail.push({
    routeId: route.routeId,
    truckId: route.truckId,
    status: route.status,
    version: route.version,
    actor: route.updatedBy,
    at: route.updatedAt,
    eventType,
  })
  return { routes: { ...state.routes, [route.routeId]: route }, auditTrail: state.auditTrail }
}

export const createRoutesSlice: StateCreator<FleetPulseStore, [], [], RoutesSlice> = (set) => ({
  routes: createInitialRoutesState(),
  applyRouteAssigned: (route) => set((state) => ({ routes: applyRouteEcho(state.routes, route, 'assigned') })),
  applyRouteUpdated: (route) => set((state) => ({ routes: applyRouteEcho(state.routes, route, 'updated') })),
  applyRouteReassigned: (route) => set((state) => ({ routes: applyRouteEcho(state.routes, route, 'reassigned') })),
  resetRoutes: () => set((state) => ({ routes: { routes: {}, auditTrail: state.routes.auditTrail } })),
})

/** Every route this session has seen, truckId-ascending (numeric-aware,
 * mirroring `selectFleetTrucks`), tie-broken by `routeId` — a stable render
 * order for `RoutesPanel`'s list. */
export function selectRoutes(state: Pick<FleetPulseStore, 'routes'>): Route[] {
  return Object.values(state.routes.routes).sort(
    (a, b) => a.truckId.localeCompare(b.truckId, undefined, { numeric: true }) || a.routeId.localeCompare(b.routeId),
  )
}

/** The session-scoped audit trail, newest-first (FR-15) — the bounded
 * buffer itself orders ascending by `at` (oldest-evicted-first, AD-10), so
 * this reverses it for display only. */
export function selectAuditTrail(state: Pick<FleetPulseStore, 'routes'>): RouteAuditEntry[] {
  return [...state.routes.auditTrail.toArray()].reverse()
}

/** The one truck→active-route lookup `VehicleDetail` reads (FR-23) —
 * mirrors `RoutesPanel.tsx`'s own local `findActiveRouteForTruck` exactly
 * (kept as two independent copies rather than a shared import per this
 * story's Boundaries: `RoutesPanel.tsx` itself is untouched). `null` when
 * the truck has no `assigned`/`in-progress` route — the panel's empty
 * state, not an error. */
export function selectRouteForTruck(state: Pick<FleetPulseStore, 'routes'>, truckId: string): Route | null {
  return (
    Object.values(state.routes.routes).find(
      (route) => route.truckId === truckId && (route.status === 'assigned' || route.status === 'in-progress'),
    ) ?? null
  )
}
