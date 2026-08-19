// FleetPulse — SSE connection manager (AD-8)
//
// The other of transport's two connection owners (the other is
// ws-manager.ts). Owns the one EventSource instance for
// `GET /api/telemetry/stream`: connect/reconnect with the same manual
// backoff curve as ws-manager, and parses each frame into a
// `TelemetryBatch` handed to an injected `onBatch` — store/pipeline don't
// exist until story 4+ (this story's Design Notes: handler injection, not
// direct import).
//
// Manual reconnect, not native EventSource retry: EventSource's built-in
// retry uses a fixed delay that doesn't match the spec'd 1s-doubling-to-15s
// curve, so this closes and recreates the EventSource itself on error,
// mirroring ws-manager's reconnect loop (story Design Notes).
//
// Story 10 adds `getEventsPerSecond()` — FR-30's one net-new metric, with no
// prior groundwork — mirroring the existing dropped/reconnect counters'
// style rather than a new abstraction (Design Notes).

import type { TelemetryBatch } from '../contract/telemetry.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'

/** The minimal shape sse-manager needs from an EventSource — satisfied by
 * the real global `EventSource` in a browser and by test fakes alike. */
export interface EventSourceLike {
  close(): void
  onopen: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}

export interface CreateSseManagerOptions {
  /** Relative URL so Vite's dev proxy forwards it (vite.config.ts's `/api/`
   * rule); defaults to `/api/telemetry/stream`. */
  url?: string
  /** Every successfully-parsed `TelemetryBatch` frame is forwarded here. */
  onBatch: (batch: TelemetryBatch) => void
  /** Fired once per frame that fails to parse as JSON or doesn't have the
   * `TelemetryBatch` shape — dropped safely, never thrown. */
  onDroppedMessage?: (raw: unknown) => void
  /** Fired with `true` every time the underlying `EventSource` opens
   * (including the very first connect and every reconnect), and `false`
   * every time it errors — the seam `app/bootstrap.ts` wires into the
   * health slice's `telemetryStreamDown` condition (AD-9, FR-26). Never
   * fired for a stale/superseded source's late callback, same as
   * `onBatch`/`onDroppedMessage`. */
  onConnectionChange?: (connected: boolean) => void
  /** Injection seam for tests; defaults to the global `EventSource`
   * constructor. */
  createEventSource?: (url: string) => EventSourceLike
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  /** Clock used for the events/sec rolling window (FR-30, story 10);
   * defaults to `Date.now`. Explicit injection over relying on a test's
   * fake-timer `Date` mocking, matching `ws-manager`'s own `now` option and
   * `api-client`'s pattern (DECISIONS.md, story 1.3). */
  now?: () => number
}

export interface SseManager {
  /** Opens the connection (idempotent — a no-op while already connecting
   * or connected). */
  connect(): void
  /** Tears the connection down for good: cancels any pending reconnect and
   * does not reconnect afterward. */
  close(): void
  /** Count of frames dropped as unparsable or non-`TelemetryBatch`-shaped
   * (FR-33 obs) — mirrors ws-manager's `getDroppedMessageCount()`. */
  getDroppedMessageCount(): number
  /** Count of reconnects that have actually reopened a connection — i.e.
   * every time a scheduled backoff timer fires, not the initial
   * `connect()` (FR-30 obs, story 10's developer panel). */
  getReconnectCount(): number
  /** SSE events/sec (FR-30, story 10): a rolling count of frames received
   * in the last `SSE_EVENTS_PER_SEC_WINDOW_MS`, divided by the window in
   * seconds — mirrors the dropped/reconnect counters' style rather than
   * introducing a new metrics abstraction (Design Notes). Counts every
   * frame the underlying `EventSource` delivers, parseable or not — this is
   * a transport-activity rate, not a parse-success rate (the dropped-count
   * getter already covers parse failures separately). Known limitation
   * (code-review finding, matches the story's own Design Notes — a fixed-
   * window average, not an elapsed-time-based one): divides by the full
   * window width rather than by time-since-oldest-counted-frame, so for the
   * first `SSE_EVENTS_PER_SEC_WINDOW_MS` after a fresh `connect()` (or any
   * quiet gap), the reported rate under-reports the real instantaneous
   * rate; it self-corrects once the window fills with real frames. */
  getEventsPerSecond(): number
}

function defaultCreateEventSource(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike
}

/** Runtime shape check for one SSE frame — transport only relays; trust
 * classification of the readings themselves is the pipeline's job (AD-3),
 * not this module's. */
function isTelemetryBatch(value: unknown): value is TelemetryBatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { truckId?: unknown }).truckId === 'string' &&
    Array.isArray((value as { readings?: unknown }).readings)
  )
}

export function createSseManager(options: CreateSseManagerOptions): SseManager {
  const url = options.url ?? '/api/telemetry/stream'
  const createEventSource = options.createEventSource ?? defaultCreateEventSource
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
  const now = options.now ?? Date.now

  let source: EventSourceLike | null = null
  let closedByUser = false
  let droppedMessageCount = 0
  let reconnectCount = 0
  // FR-30 events/sec: timestamps of frames received within the current
  // rolling window, oldest first — pruned lazily (on the next record or
  // read) rather than by its own timer, same "no extra interval" spirit as
  // the rest of this module's backoff/reconnect bookkeeping.
  let eventTimestamps: number[] = []
  // `CLIENT_THRESHOLDS` is `Object.freeze`d, so TS infers its properties as
  // literal types (e.g. `1000`, not `number`) — annotate explicitly so
  // reassignment below (doubling toward the cap) type-checks.
  let currentBackoffMs: number = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

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
      // Only a timer that actually fires and reopens a connection counts as
      // a reconnect (FR-30 obs) — the initial connect() never runs this path.
      reconnectCount += 1
      openSource()
    }, currentBackoffMs)
    currentBackoffMs = Math.min(
      currentBackoffMs * CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER,
      CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS,
    )
  }

  function pruneEventWindow(nowMs: number): void {
    const cutoff = nowMs - CLIENT_THRESHOLDS.SSE_EVENTS_PER_SEC_WINDOW_MS
    while (eventTimestamps.length > 0 && eventTimestamps[0]! < cutoff) eventTimestamps.shift()
  }

  function handleRawFrame(raw: unknown) {
    // FR-30: every frame the connection actually delivers counts toward
    // events/sec, whether it goes on to parse successfully or not — this
    // metric answers "how active is the stream," not "how much of it is
    // valid" (the separate dropped-count getter already answers that).
    const receivedAtMs = now()
    eventTimestamps.push(receivedAtMs)
    pruneEventWindow(receivedAtMs)

    let parsed: unknown
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      droppedMessageCount += 1
      options.onDroppedMessage?.(raw)
      return
    }
    if (!isTelemetryBatch(parsed)) {
      droppedMessageCount += 1
      options.onDroppedMessage?.(parsed)
      return
    }
    options.onBatch(parsed)
  }

  function closeCurrentSource() {
    const current = source
    source = null
    current?.close()
  }

  function openSource() {
    closedByUser = false
    closeCurrentSource()
    const mySource = createEventSource(url)
    source = mySource

    mySource.onopen = () => {
      if (source !== mySource) return // stale callback from a superseded source
      currentBackoffMs = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
      options.onConnectionChange?.(true)
    }

    mySource.onmessage = (event) => {
      if (source !== mySource) return
      handleRawFrame(event.data)
    }

    // EventSource's native retry is bypassed (see file header) — on any
    // error, close this instance and drive reconnection through the same
    // manual backoff ws-manager uses, rather than letting the browser's
    // own fixed-delay retry race with ours.
    mySource.onerror = () => {
      if (source !== mySource) return
      source = null
      mySource.close()
      options.onConnectionChange?.(false)
      if (!closedByUser) scheduleReconnect()
    }
  }

  return {
    connect() {
      if (source !== null || reconnectTimer !== null) return
      // A fresh connect() (e.g. after close()) always starts the backoff
      // curve over — otherwise a prior escalated backoff would leak into
      // this unrelated connection attempt's own first reconnect.
      currentBackoffMs = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
      openSource()
    },
    close() {
      closedByUser = true
      cancelReconnect()
      closeCurrentSource()
      // FR-30/code-review patch: a deliberate close() followed by a fresh
      // connect() must not carry pre-close activity into the new
      // connection's events/sec reading — unlike the lifetime
      // dropped/reconnect counters (intentionally cumulative across
      // reconnects), this is a *rate*, and a closed connection has no
      // "current" rate to report.
      eventTimestamps = []
    },
    getDroppedMessageCount() {
      return droppedMessageCount
    },
    getReconnectCount() {
      return reconnectCount
    },
    getEventsPerSecond() {
      pruneEventWindow(now())
      return eventTimestamps.length / (CLIENT_THRESHOLDS.SSE_EVENTS_PER_SEC_WINDOW_MS / 1000)
    },
  }
}
