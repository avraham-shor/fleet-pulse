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
  /** Injection seam for tests; defaults to the global `EventSource`
   * constructor. */
  createEventSource?: (url: string) => EventSourceLike
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
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

  let source: EventSourceLike | null = null
  let closedByUser = false
  let droppedMessageCount = 0
  let reconnectCount = 0
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

  function handleRawFrame(raw: unknown) {
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
    },
    getDroppedMessageCount() {
      return droppedMessageCount
    },
    getReconnectCount() {
      return reconnectCount
    },
  }
}
