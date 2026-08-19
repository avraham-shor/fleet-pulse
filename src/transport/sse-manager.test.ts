// FleetPulse — sse-manager tests (AD-8, FR-27)
//
// Runs in the node environment against a fake EventSource (this module
// imports no React and no DOM) — the injected `createEventSource` seam
// keeps these deterministic and offline, driven by vitest's fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSseManager } from './sse-manager.ts'
import type { EventSourceLike } from './sse-manager.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'

class FakeEventSource implements EventSourceLike {
  url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  close() {
    this.closed = true
  }

  // --- test helpers, not part of the EventSourceLike contract -----------
  simulateOpen() {
    this.onopen?.()
  }

  simulateFrame(raw: unknown) {
    this.onmessage?.({ data: raw })
  }

  simulateMessage(batch: unknown) {
    this.simulateFrame(JSON.stringify(batch))
  }

  simulateError() {
    this.onerror?.()
  }
}

function setup() {
  const instances: FakeEventSource[] = []
  const onBatch = vi.fn()
  const onDroppedMessage = vi.fn()
  const manager = createSseManager({
    onBatch,
    onDroppedMessage,
    createEventSource: (url) => {
      const source = new FakeEventSource(url)
      instances.push(source)
      return source
    },
  })
  return { manager, instances, onBatch, onDroppedMessage }
}

const SAMPLE_BATCH = {
  truckId: 'truck_1',
  readings: [{ truckId: 'truck_1', timestamp: 1000, lat: 32.1, lng: 34.8, speed: 40, fuel: 80, engineTemp: 75, mileage: 1000 }],
}

describe('sse-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connect() opens one EventSource to /api/telemetry/stream by default', () => {
    const { manager, instances } = setup()
    manager.connect()
    expect(instances).toHaveLength(1)
    expect(instances[0]?.url).toBe('/api/telemetry/stream')
  })

  it('parses a TelemetryBatch frame and forwards it to onBatch', () => {
    const { manager, instances, onBatch } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    instances[0]!.simulateMessage(SAMPLE_BATCH)
    expect(onBatch).toHaveBeenCalledTimes(1)
    expect(onBatch).toHaveBeenCalledWith(SAMPLE_BATCH)
  })

  it('FR-33: drops a malformed or non-batch-shaped frame safely — never thrown, never forwarded, counted', () => {
    const { manager, instances, onBatch, onDroppedMessage } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    expect(manager.getDroppedMessageCount()).toBe(0)

    expect(() => instances[0]!.simulateFrame('not json{')).not.toThrow()
    expect(() => instances[0]!.simulateMessage({ truckId: 'truck_1' /* missing readings */ })).not.toThrow()
    expect(() => instances[0]!.simulateMessage([1, 2, 3])).not.toThrow()

    expect(onBatch).not.toHaveBeenCalled()
    expect(onDroppedMessage).toHaveBeenCalledTimes(3)
    expect(manager.getDroppedMessageCount()).toBe(3)
  })

  it('SSE reconnect: on error, closes and recreates the EventSource once the backoff elapses (same curve as WS)', () => {
    const { manager, instances } = setup()
    manager.connect()
    instances[0]!.simulateOpen()

    instances[0]!.simulateError()
    expect(instances[0]!.closed).toBe(true)
    expect(instances).toHaveLength(1) // not yet — backoff hasn't elapsed

    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)
    expect(instances[1]?.url).toBe('/api/telemetry/stream')
  })

  it('doubles the backoff on repeated errors and resets it after a successful open', () => {
    const { manager, instances } = setup()
    manager.connect()

    const initial = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
    const multiplier = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER

    instances[0]!.simulateError()
    vi.advanceTimersByTime(initial)
    expect(instances).toHaveLength(2)

    instances[1]!.simulateError()
    vi.advanceTimersByTime(initial * multiplier - 1)
    expect(instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(instances).toHaveLength(3)

    instances[2]!.simulateOpen()
    instances[2]!.simulateError()
    vi.advanceTimersByTime(initial - 1)
    expect(instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(instances).toHaveLength(4)
  })

  it('FR-30: getReconnectCount() counts only reconnects that actually reopen a connection, not the first connect()', () => {
    const { manager, instances } = setup()
    manager.connect()
    expect(manager.getReconnectCount()).toBe(0) // the initial connect() is not a reconnect

    instances[0]!.simulateOpen()
    instances[0]!.simulateError()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)
    expect(manager.getReconnectCount()).toBe(1)

    instances[1]!.simulateError() // never opened — still counts once the timer fires
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS * CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER)
    expect(instances).toHaveLength(3)
    expect(manager.getReconnectCount()).toBe(2)
  })

  it('a fresh connect() after close() restarts the backoff curve at its initial value', () => {
    const { manager, instances } = setup()
    manager.connect()

    // Escalate the backoff past its initial value with a couple of errors.
    instances[0]!.simulateError()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    instances[1]!.simulateError()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS * CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER)
    expect(instances).toHaveLength(3)

    manager.close()
    manager.connect() // a brand-new, unrelated connection attempt
    expect(instances).toHaveLength(4)

    // If this fresh attempt also errors, the very next reconnect must wait
    // only the initial backoff again — not the escalated value left over
    // from the previous connection's own errors.
    instances[3]!.simulateError()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS - 1)
    expect(instances).toHaveLength(4)
    vi.advanceTimersByTime(1)
    expect(instances).toHaveLength(5)
  })

  it('ignores late callbacks from a superseded (stale) EventSource after a reconnect', () => {
    const { manager, instances, onBatch } = setup()
    manager.connect()
    instances[0]!.simulateOpen()

    instances[0]!.simulateError()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)
    instances[1]!.simulateOpen()

    const onBatchCallsBefore = onBatch.mock.calls.length
    const reconnectCountBefore = manager.getReconnectCount()
    const droppedBefore = manager.getDroppedMessageCount()

    // Directly invoke the stale (superseded) source's own handler
    // references — simulating a late-arriving event on an object the
    // manager has already moved on from — and assert the `source !==
    // mySource` guard makes every one of them a no-op.
    instances[0]!.onopen?.()
    instances[0]!.onmessage?.({ data: JSON.stringify(SAMPLE_BATCH) })

    expect(onBatch).toHaveBeenCalledTimes(onBatchCallsBefore) // stale frame never forwarded
    expect(manager.getReconnectCount()).toBe(reconnectCountBefore)
    expect(manager.getDroppedMessageCount()).toBe(droppedBefore)
    expect(instances).toHaveLength(2) // no new source created from the stale callbacks
  })

  it('AD-9/FR-26: onConnectionChange fires true on open and false on error, and never for a stale superseded source', () => {
    const onConnectionChange = vi.fn()
    const instances: FakeEventSource[] = []
    const manager = createSseManager({
      onBatch: vi.fn(),
      onConnectionChange,
      createEventSource: (url) => {
        const source = new FakeEventSource(url)
        instances.push(source)
        return source
      },
    })

    manager.connect()
    expect(onConnectionChange).not.toHaveBeenCalled()

    instances[0]!.simulateOpen()
    expect(onConnectionChange).toHaveBeenLastCalledWith(true)

    instances[0]!.simulateError()
    expect(onConnectionChange).toHaveBeenLastCalledWith(false)

    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)
    onConnectionChange.mockClear()

    // A late callback from the now-superseded first source must never fire
    // onConnectionChange again.
    instances[0]!.onopen?.()
    instances[0]!.onerror?.()
    expect(onConnectionChange).not.toHaveBeenCalled()

    instances[1]!.simulateOpen()
    expect(onConnectionChange).toHaveBeenCalledTimes(1)
    expect(onConnectionChange).toHaveBeenLastCalledWith(true)
  })

  it('close() tears the connection down for good — no further reconnect attempts', () => {
    const { manager, instances } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    manager.close()
    expect(instances[0]!.closed).toBe(true)

    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS * 4)
    expect(instances).toHaveLength(1)
  })
})
