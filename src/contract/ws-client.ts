// FleetPulse — wire contract: client→server WebSocket message set (AD-13)
//
// Declares exactly the three client→server message types the brief names
// (register_dispatcher, ping, viewing_truck) — this story's half of AD-13.
// `type` values are brief-verbatim (snake_case, per the Consistency
// Conventions table); payload field names follow the same camelCase
// convention the brief itself uses for `dispatcherId`.
//
// Must match server.js's actual parsing exactly (server.js:720-785,
// handleWsMessage/handleRegister/handleViewing): `name` is read only if it's
// a non-empty string (optional otherwise — the server falls back to
// "Anonymous"); `viewing_truck.truckId` is read as `string | null` (any
// other type is treated as `null`).
//
// Server→client shapes (registered, dispatcher_joined/_left/_viewing,
// route_assigned/_updated/_reassigned, truck_alert, fleet_reset, pong) are
// declared in ./ws-server.ts, story 1.2's half of AD-13 — not redeclared
// here.

/** Registers this socket with the server and requests a fresh, server-issued
 * `dispatcherId` (replied to with `registered`, AD-17). `name` is optional —
 * the server substitutes "Anonymous" for a missing or blank one
 * (server.js:733). Also the message ws-manager re-sends on every reconnect
 * (AD-8), since a new socket always means a fresh identity. */
export interface RegisterDispatcherMessage {
  type: 'register_dispatcher'
  name?: string
}

/** Keepalive heartbeat, sent by ws-manager every `WS_KEEPALIVE_PING_MS`
 * (AD-8); the server replies with `pong` to that socket only, and also
 * re-broadcasts this dispatcher's current `dispatcher_viewing` state to
 * peers as a presence liveness refresh (FR-19 fix, server.js's `ping`
 * handler) — closes the gap where an idle-but-connected dispatcher who
 * never changes their viewing target would otherwise vanish from peers'
 * presence after `PRESENCE_LIVENESS_TIMEOUT_MS`. */
export interface PingMessage {
  type: 'ping'
}

/** Announces (or, with `truckId: null`, explicitly clears — FR-18) which
 * truck this dispatcher is currently viewing. The server broadcasts the
 * change to every other dispatcher as `dispatcher_viewing`. */
export interface ViewingTruckMessage {
  type: 'viewing_truck'
  truckId: string | null
}

export type ClientWsMessage = RegisterDispatcherMessage | PingMessage | ViewingTruckMessage
