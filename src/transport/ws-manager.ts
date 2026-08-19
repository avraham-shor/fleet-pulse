// FleetPulse — WS connection manager (AD-8, AD-17)
//
// One of transport's two connection owners (the other is sse-manager.ts).
// Owns the one WebSocket instance: connect/reconnect with manual backoff,
// re-registration, keepalive ping/pong, and the session-scoped
// `dispatcherId` field (AD-17) — nothing above transport opens a socket or
// interprets a WS message.
//
// store/ doesn't exist until story 4+, so this manager takes injected
// handlers (`onMessage`, `onConnect`) at construction instead of importing
// a not-yet-built slice — the seam the story's Design Notes call out
// ("Handler injection, not direct store import"). A later story's app/
// composition root wires its own slice actions in as these handlers.

import type { ServerWsMessage } from '../contract/ws-server.ts'
import type { ClientWsMessage } from '../contract/ws-client.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'

// The standard WebSocket readyState values (CONNECTING=0, OPEN=1,
// CLOSING=2, CLOSED=3) — a web platform constant, not an AD-2 tunable, so
// it stays a local literal rather than a shared/constants.js entry.
const WS_READY_STATE_OPEN = 1

/** The minimal shape ws-manager needs from a WebSocket — satisfied by the
 * real global `WebSocket` and by test fakes alike (the injection seam that
 * keeps this module unit-testable without a live socket). */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}

// Every server->client `type` this manager recognizes, keyed so TypeScript
// enforces the set stays exhaustive against contract/ws-server.ts's own
// union: adding a tenth message type there without updating this object is
// a compile error, not a silently-dropped message at runtime.
const KNOWN_SERVER_MESSAGE_TYPES = {
  registered: true,
  dispatcher_joined: true,
  dispatcher_left: true,
  dispatcher_viewing: true,
  route_assigned: true,
  route_updated: true,
  route_reassigned: true,
  truck_alert: true,
  fleet_reset: true,
  pong: true,
} satisfies Record<ServerWsMessage['type'], true>

function isKnownServerMessageType(type: string): type is ServerWsMessage['type'] {
  return Object.prototype.hasOwnProperty.call(KNOWN_SERVER_MESSAGE_TYPES, type)
}

export interface CreateWsManagerOptions {
  /** Relative URL so Vite's dev proxy forwards it (vite.config.ts's `/ws`
   * rule); defaults to `/ws`. */
  url?: string
  /** Sent with every `register_dispatcher`, including on reconnect — a
   * reconnect always gets a fresh identity (FR-16). This is only the
   * *initial* name: `register(name)` below updates the mutable current
   * name every subsequent `register_dispatcher` (auto or manual) sends. */
  dispatcherName?: string
  /** Every recognized server->client message except `registered` and
   * `pong` — both consumed internally (AD-17 identity, keepalive plumbing)
   * — is forwarded here. */
  onMessage: (msg: ServerWsMessage) => void
  /** Fired once per successful connection (including the first) right
   * after `register_dispatcher` has been (re-)sent — the seam a later
   * story's presence slice rebuilds from on every reconnect (AD-8). */
  onConnect: () => void
  /** Fired once per dropped frame: unparsable JSON, a non-object payload,
   * or an unrecognized `type` — counted for obs (FR-33) rather than
   * thrown. */
  onDroppedMessage?: (raw: unknown) => void
  /** Injection seam for tests; defaults to the global `WebSocket`
   * constructor. */
  createSocket?: (url: string) => WebSocketLike
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  setIntervalImpl?: typeof setInterval
  clearIntervalImpl?: typeof clearInterval
  /** Clock used for ping/pong RTT measurement; defaults to `Date.now`. */
  now?: () => number
}

export interface WsManager {
  /** Opens the socket (idempotent — a no-op while already connecting or
   * connected). */
  connect(): void
  /** Tears the connection down for good: cancels any pending reconnect and
   * the keepalive ping, and does not reconnect afterward. */
  close(): void
  /** Sets the mutable current dispatcher name and (re-)registers this
   * socket under it: sent immediately if the socket is already open —
   * reusing `server.js`'s existing re-registration handling
   * (`handleRegister`, `server.js:721-733`), which always issues a fresh
   * `dispatcherId` even for an already-registered socket (Design Notes) —
   * or, while the socket isn't open yet, just updates the name that the
   * next `onopen`'s auto-register-on-open send picks up. Never silently
   * dropped either way (AD-1's widened facade). */
  register(name: string): void
  /** The typed send-only facade `ui/` is allowed to call directly (AD-1).
   * A no-op while the socket isn't open — there is nothing useful to queue
   * a stale viewing-truck update behind. */
  sendViewing(truckId: string | null): void
  /** The session-scoped identity (AD-17): set only on `registered`, cleared
   * only on socket loss. `api-client` reads this live. */
  getDispatcherId(): string | null
  /** Count of frames dropped as unrecognized (FR-33 obs). */
  getDroppedMessageCount(): number
  /** Most recent ping/pong round-trip time in ms, or `null` before the
   * first completed round trip — feeds FR-30's latency metric (AD-8,
   * constants.md). */
  getLastPingRttMs(): number | null
  /** Count of reconnects that have actually reopened a socket — i.e. every
   * time a scheduled backoff timer fires, not the initial `connect()`
   * (FR-30 obs, story 10's developer panel). */
  getReconnectCount(): number
}

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike
}

export function createWsManager(options: CreateWsManagerOptions): WsManager {
  const url = options.url ?? '/ws'
  const createSocket = options.createSocket ?? defaultCreateSocket
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval
  const now = options.now ?? Date.now

  let socket: WebSocketLike | null = null
  let dispatcherId: string | null = null
  // The mutable current name `register()` updates — replaces the old fixed
  // read of `options.dispatcherName`, which only ever reflected the name
  // passed at construction. `options.dispatcherName` seeds it; every call
  // to `register()` after that overwrites it for every subsequent send
  // (including a later reconnect's own auto-register-on-open).
  let currentDispatcherName: string | undefined = options.dispatcherName
  let droppedMessageCount = 0
  let reconnectCount = 0
  let lastPingSentAtMs: number | null = null
  let lastPingRttMs: number | null = null
  let closedByUser = false
  // `CLIENT_THRESHOLDS` is `Object.freeze`d, so TS infers its properties as
  // literal types (e.g. `1000`, not `number`) — annotate explicitly so
  // reassignment below (doubling toward the cap) type-checks.
  let currentBackoffMs: number = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  function stopPing() {
    if (pingTimer !== null) {
      clearIntervalImpl(pingTimer)
      pingTimer = null
    }
  }

  function startPing() {
    stopPing()
    pingTimer = setIntervalImpl(() => {
      if (socket && socket.readyState === WS_READY_STATE_OPEN) {
        const ping: ClientWsMessage = { type: 'ping' }
        socket.send(JSON.stringify(ping))
        lastPingSentAtMs = now()
      }
    }, CLIENT_THRESHOLDS.WS_KEEPALIVE_PING_MS)
  }

  function cancelReconnect() {
    if (reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer)
      reconnectTimer = null
    }
  }

  function scheduleReconnect() {
    cancelReconnect()
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null
      // Only a timer that actually fires and reopens a socket counts as a
      // reconnect (FR-30 obs) — the initial connect() never runs this path.
      reconnectCount += 1
      openSocket()
    }, currentBackoffMs)
    currentBackoffMs = Math.min(
      currentBackoffMs * CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER,
      CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS,
    )
  }

  function handleRawMessage(raw: unknown) {
    let parsed: unknown
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      droppedMessageCount += 1
      options.onDroppedMessage?.(raw)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      droppedMessageCount += 1
      options.onDroppedMessage?.(parsed)
      return
    }
    const type = (parsed as { type: string }).type
    if (!isKnownServerMessageType(type)) {
      droppedMessageCount += 1
      options.onDroppedMessage?.(parsed)
      return
    }
    const msg = parsed as ServerWsMessage
    // `registered` and `pong` are session/keepalive plumbing this manager
    // owns outright (AD-17) — never forwarded as domain events.
    if (msg.type === 'registered') {
      dispatcherId = msg.dispatcherId
      return
    }
    if (msg.type === 'pong') {
      // Ping/pong RTT feeds FR-30's latency metric (AD-8, constants.md).
      // `lastPingSentAtMs` is null if a pong arrives with no matching ping
      // outstanding (e.g. a stray/duplicate frame) — leave the previous
      // RTT reading in place rather than computing a bogus one.
      if (lastPingSentAtMs !== null) {
        lastPingRttMs = now() - lastPingSentAtMs
        lastPingSentAtMs = null
      }
      return
    }
    options.onMessage(msg)
  }

  function openSocket() {
    closedByUser = false
    const mySocket = createSocket(url)
    socket = mySocket

    mySocket.onopen = () => {
      if (socket !== mySocket) return // stale callback from a superseded socket
      currentBackoffMs = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
      const register: ClientWsMessage = currentDispatcherName
        ? { type: 'register_dispatcher', name: currentDispatcherName }
        : { type: 'register_dispatcher' }
      mySocket.send(JSON.stringify(register))
      startPing()
      options.onConnect()
    }

    mySocket.onmessage = (event) => {
      if (socket !== mySocket) return
      handleRawMessage(event.data)
    }

    // A socket-level error isn't itself actionable — the 'close' event
    // every socket eventually gets drives cleanup and reconnect, mirroring
    // server.js's own ws.on('error', () => {}) (server.js:829).
    mySocket.onerror = () => {}

    mySocket.onclose = () => {
      if (socket !== mySocket) return // already superseded — nothing to clean up
      socket = null
      dispatcherId = null
      stopPing()
      if (!closedByUser) scheduleReconnect()
    }
  }

  return {
    connect() {
      if (socket !== null || reconnectTimer !== null) return
      // A fresh connect() (e.g. after close()) always starts the backoff
      // curve over — otherwise a prior escalated backoff would leak into
      // this unrelated connection attempt's own first reconnect.
      currentBackoffMs = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
      openSocket()
    },
    close() {
      closedByUser = true
      cancelReconnect()
      stopPing()
      dispatcherId = null
      const current = socket
      socket = null
      current?.close()
    },
    register(name: string) {
      // Guards against an empty name producing a wire message with an
      // explicit empty `name` field when the socket happens to already be
      // open, while the exact same call would instead fall back to an
      // *anonymous* register_dispatcher (no `name` field at all) via the
      // `onopen` ternary above if the socket weren't open yet — same
      // input, different wire shape depending on unrelated timing. The
      // current caller (`PresencePanel`) already trims and blocks empty
      // submits, so this is defense-in-depth for the exported API's
      // contract, not a behavior change for any path exercised today.
      // Trimmed, not just `=== ''`: a whitespace-only name (e.g. '   ')
      // would otherwise slip past this guard and reach the wire literally
      // (code-review finding — the guard's own contract is "no blank
      // name", not "no exactly-empty-string name").
      if (name.trim() === '') return
      currentDispatcherName = name
      if (socket && socket.readyState === WS_READY_STATE_OPEN) {
        const msg: ClientWsMessage = { type: 'register_dispatcher', name }
        socket.send(JSON.stringify(msg))
      }
      // Else: nothing to send yet — the name is durably held in
      // `currentDispatcherName`, so whichever `onopen` fires next (the
      // in-flight initial connect, or a future reconnect) auto-registers
      // under it. Never silently dropped.
    },
    sendViewing(truckId: string | null) {
      if (!socket || socket.readyState !== WS_READY_STATE_OPEN) return
      const msg: ClientWsMessage = { type: 'viewing_truck', truckId }
      socket.send(JSON.stringify(msg))
    },
    getDispatcherId() {
      return dispatcherId
    },
    getDroppedMessageCount() {
      return droppedMessageCount
    },
    getLastPingRttMs() {
      return lastPingRttMs
    },
    getReconnectCount() {
      return reconnectCount
    },
  }
}

/** The narrow send-only shape `ui/` is allowed to reach transport with —
 * story 1.6's facade (register + sendViewing only, never `connect`/`close`).
 * `getDispatcherId` is story 7's additive, optional widening: `RoutesPanel`
 * needs a live read of the session-scoped identity (AD-17) to construct its
 * own `api-client` instance without importing `ws-manager` outright (AD-1)
 * — optional so this stays backward-compatible with `PresencePanel.tsx` and
 * its tests, which never read it. */
export interface WsSendFacade {
  register(name: string): void
  sendViewing(truckId: string | null): void
  getDispatcherId?(): string | null
}

let wsSendFacade: WsSendFacade | null = null

/** Registration seam for `app/`'s composition root (mirrors `store.ts`'s
 * `getFleetPulseStore` singleton pattern, but push-set rather than
 * lazily-constructed here: unlike the store, a `WsManager` needs injected
 * `onMessage`/`onConnect` handlers at construction, so `app/` builds the
 * real one and hands it in — this module never constructs it itself).
 * `app/` calls this exactly once, right after constructing the production
 * `wsManager`. */
export function setWsSendFacade(facade: WsSendFacade): void {
  wsSendFacade = facade
}

/** `ui/`'s only legal way to reach `transport/ws-manager` (AD-1). Returns
 * `null` before `app/`'s composition root has wired the production
 * manager in yet (e.g. a widget rendering before `getBootstrap()` runs) —
 * callers treat that as "nothing to send yet," never a crash. */
export function getWsSendFacade(): WsSendFacade | null {
  return wsSendFacade
}

/** Test-only: clears the singleton so each test starts from a clean slate.
 * Production code never calls this. */
export function resetWsSendFacadeForTests(): void {
  wsSendFacade = null
}
