// FleetPulse — wire contract: REST response and error bodies (AD-13)
//
// Declares exactly what `server.js`'s REST endpoints emit. Endpoint paths,
// methods, and headers (`X-Dispatcher-Id`, `If-Match`, `Retry-After`) are
// fixed by the brief; body field names are brief-verbatim where given
// (`dispatcherId`) and this file is authoritative where the brief is
// silent (AD-13) — camelCase throughout, matching the brief's own example.

/** Visually distinct at a glance (brief, Requirements §1); brief-verbatim
 * enum values. */
export type TruckStatus = 'active' | 'idle' | 'maintenance'

/** A single truck's current snapshot, as returned by `GET /api/fleet` and
 * `GET /api/fleet/:truckId`. Mirrors the latest telemetry reading the
 * server has recorded for this truck (newest-by-timestamp wins, same rule
 * FR-6 asks of the client) plus its status and current route link. */
export interface Truck {
  truckId: string
  status: TruckStatus
  lat: number
  lng: number
  speed: number
  fuel: number
  engineTemp: number
  mileage: number
  /** Reading timestamp of the snapshot above, epoch ms. */
  timestamp: number
  /** The truck's current active (assigned/in-progress) route, if any. */
  routeId: string | null
}

/** Brief-verbatim status transitions (Requirements §2 / FR-11):
 * `assigned` → `in-progress` | `cancelled`; `in-progress` → `completed` |
 * `cancelled`; `completed`/`cancelled` are terminal. */
export type RouteStatus = 'assigned' | 'in-progress' | 'completed' | 'cancelled'

/** The acting dispatcher attached to a route event — carries both the
 * opaque server-issued id and the display name, so a 409's conflicting
 * dispatcher (and every audit entry) never needs a presence lookup
 * (AD-11, FR-13). The permanent quirk-#8 actor is one of these too:
 * `{ dispatcherId: 'dispatcher_system', name: 'System' }` (AD-12). */
export interface RouteActor {
  dispatcherId: string
  name: string
}

/** A route, as returned by `GET /api/routes`, `POST /api/routes`, and every
 * route mutation/broadcast. `version` is the server-side integer echoed via
 * `If-Match` (optimistic locking, FR-12). */
export interface Route {
  routeId: string
  truckId: string
  status: RouteStatus
  version: number
  destination: string
  createdBy: RouteActor
  createdAt: number
  updatedAt: number
  updatedBy: RouteActor
}

/** An alert sent to a truck, as returned by `POST /api/fleet/:truckId/alert`
 * and broadcast (as `truck_alert`) to every dispatcher (FR-32). */
export interface TruckAlert {
  truckId: string
  message: string
  dispatcherId: string
  dispatcherName: string
  timestamp: number
}

/** The generic REST error body shape — every non-2xx JSON response uses
 * this shape or an extension of it. `error` is a short machine code,
 * `message` a human-readable string safe to render as-is (untrusted
 * display text, never interpreted — NFR-8). */
export interface ApiErrorBody {
  error: string
  message: string
}

/** The 409 conflict body — the *only* conflict shape in the contract,
 * shared verbatim by stale-`If-Match` rejections (quirk #4) and
 * mid-processing races (quirk #8), per AD-11/FR-13: it carries the
 * conflicting dispatcher's id and display name plus the full current route
 * state, so the conflict UI never depends on a presence lookup. */
export interface ConflictErrorBody extends ApiErrorBody {
  error: 'version_conflict'
  conflictingDispatcher: RouteActor
  currentRoute: Route
}

/** `GET /api/fleet`'s 503 body (15% chance, `Retry-After` header carries
 * the retry seconds separately — not duplicated in the body). */
export interface FleetUnavailableErrorBody extends ApiErrorBody {
  error: 'fleet_unavailable'
}

/** `POST /api/reset`'s acknowledgement body. */
export interface ResetAckBody {
  reset: true
}

// --- Request bodies (client -> server) --------------------------------
//
// Story 1.3's half of AD-13: the four mutating REST endpoints' bodies.
// Header fields (`X-Dispatcher-Id`, `If-Match`) are transport concerns
// (api-client, AD-7), not part of these body shapes. Field names mirror
// server.js's actual `req.body?.*` reads exactly (server.js:868-869 POST
// /api/routes, :907 PATCH status, :940 PUT reassign truckId, :965 POST
// alert message).

/** `POST /api/routes` body — creates a route and assigns it to a truck
 * (FR-10). No version to check (a create has none yet); FR-34's
 * warn-and-confirm covers the "truck already has an active route" race
 * client-side instead. */
export interface CreateRouteRequestBody {
  truckId: string
  destination: string
}

/** `PATCH /api/routes/:routeId` body — a status transition (FR-11), version-
 * checked via `If-Match` (FR-12). */
export interface UpdateRouteStatusRequestBody {
  status: RouteStatus
}

/** `PUT /api/routes/:routeId/reassign` body — moves the route to a
 * different truck (FR-14), version-checked via `If-Match` (FR-12). */
export interface ReassignRouteRequestBody {
  truckId: string
}

/** `POST /api/fleet/:truckId/alert` body — sends a dispatcher-authored
 * alert to a truck (FR-22), broadcast to all dispatchers (FR-32). */
export interface SendTruckAlertRequestBody {
  message: string
}

// Deterministic quirk triggers are dev-only and quarantined by AD-11: their
// ack body is intentionally not declared here — src/contract/ is the
// client-facing production contract, and nothing under src/ references the
// dev-trigger path at all (grep-enforceable). server.contract.test.js
// asserts that endpoint's shape inline instead.
