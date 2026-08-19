// FleetPulse — wire contract: server→client WebSocket message set (AD-13)
//
// Declares exactly the nine server→client message types the brief names
// (registered, dispatcher_joined/_left/_viewing, route_assigned/_updated/
// _reassigned, truck_alert, fleet_reset, pong) plus their field shapes.
// `type` values are brief-verbatim (snake_case, per the Consistency
// Conventions table); payload field names follow the same camelCase
// convention the brief itself uses for `dispatcherId`.
//
// Client→server shapes (register_dispatcher, ping, viewing_truck) are
// story 1.3's half of AD-13 — not declared here.

import type { Route, TruckAlert } from './rest.ts'

/** Sent to a socket immediately after a successful `register_dispatcher`. */
export interface RegisteredMessage {
  type: 'registered'
  dispatcherId: string
  name: string
}

/** Broadcast when a dispatcher registers — and replayed, one per already-
 * present dispatcher, to a newly-registering socket only, since the brief's
 * protocol has no bulk presence-snapshot message type (story 1.2 design
 * choice: reuse this same type rather than invent one). */
export interface DispatcherJoinedMessage {
  type: 'dispatcher_joined'
  dispatcherId: string
  name: string
}

/** Broadcast when a dispatcher disconnects — may be delayed up to
 * `GHOST_DISCONNECT_DELAY_MS` (quirk #6). */
export interface DispatcherLeftMessage {
  type: 'dispatcher_left'
  dispatcherId: string
}

/** Broadcast whenever a dispatcher's viewed truck changes, including to
 * `null` (explicitly clearing the indicator — the brief's protocol must be
 * able to say "viewing nothing"). Also re-broadcast unchanged every time
 * that dispatcher's keepalive `ping` arrives (FR-19 liveness fix) — the
 * client's existing lastSeenAt refresh on this message type doubles as an
 * idle-but-connected heartbeat with no new message type needed. */
export interface DispatcherViewingMessage {
  type: 'dispatcher_viewing'
  dispatcherId: string
  truckId: string | null
}

/** Broadcast to all dispatchers, originator included (AD-16), on
 * `POST /api/routes`. */
export interface RouteAssignedMessage {
  type: 'route_assigned'
  route: Route
}

/** Broadcast on a successful `PATCH /api/routes/:routeId` (status/detail
 * change). Also used by the quirk-#4 dev/self-fire system-dispatcher touch. */
export interface RouteUpdatedMessage {
  type: 'route_updated'
  route: Route
}

/** Broadcast on a successful `PUT /api/routes/:routeId/reassign` — including
 * the quirk-#8 system-dispatcher chaos reassignment, which is a real
 * reassignment by a permanently-registered synthetic dispatcher, never a
 * phantom id (AD-12). */
export interface RouteReassignedMessage {
  type: 'route_reassigned'
  route: Route
}

/** Broadcast to all dispatchers, sender included (FR-32), on
 * `POST /api/fleet/:truckId/alert`. */
export interface TruckAlertMessage extends TruckAlert {
  type: 'truck_alert'
}

/** Broadcast on `POST /api/reset`, before the presence re-announcement
 * (AD-17). Carries no payload beyond its type. */
export interface FleetResetMessage {
  type: 'fleet_reset'
}

/** Sent in direct reply to a `ping`, to that socket only. */
export interface PongMessage {
  type: 'pong'
}

export type ServerWsMessage =
  | RegisteredMessage
  | DispatcherJoinedMessage
  | DispatcherLeftMessage
  | DispatcherViewingMessage
  | RouteAssignedMessage
  | RouteUpdatedMessage
  | RouteReassignedMessage
  | TruckAlertMessage
  | FleetResetMessage
  | PongMessage
