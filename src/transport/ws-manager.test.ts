// FleetPulse — ws-manager tests (AD-8, AD-17, FR-16, FR-27, FR-33)
//
// Runs in the node environment against a fake WebSocket (this module
// imports no React and no DOM) — the injected `createSocket` seam this
// story's Design Notes call for keeps these deterministic and offline,
// driven entirely by vitest's fake timers rather than a real socket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWsManager, getWsSendFacade, resetWsSendFacadeForTests, setWsSendFacade } from './ws-manager.ts'
import type { WebSocketLike } from './ws-manager.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'

const WS_OPEN = 1
const WS_CLOSED = 3

class FakeWebSocket implements WebSocketLike {
  url: string
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    if (this.readyState === WS_CLOSED) return
    this.readyState = WS_CLOSED
    this.onclose?.()
  }

  // --- test helpers, not part of the WebSocketLike contract -------------
  simulateOpen() {
    this.readyState = WS_OPEN
    this.onopen?.()
  }

  simulateServerFrame(raw: unknown) {
    this.onmessage?.({ data: raw })
  }

  simulateServerMessage(msg: unknown) {
    this.simulateServerFrame(JSON.stringify(msg))
  }

  /** An abrupt drop the manager didn't initiate — same effect as close(). */
  simulateDrop() {
    this.close()
  }
}

function setup(options: { now?: () => number } = {}) {
  const instances: FakeWebSocket[] = []
  const onMessage = vi.fn()
  const onConnect = vi.fn()
  const onDroppedMessage = vi.fn()
  const manager = createWsManager({
    dispatcherName: 'Alice',
    onMessage,
    onConnect,
    onDroppedMessage,
    now: options.now,
    createSocket: (url) => {
      const socket = new FakeWebSocket(url)
      instances.push(socket)
      return socket
    },
  })
  return { manager, instances, onMessage, onConnect, onDroppedMessage }
}

describe('ws-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connect() opens one socket to /ws by default and sends register_dispatcher on open', () => {
    const { manager, instances } = setup()
    manager.connect()
    expect(instances).toHaveLength(1)
    expect(instances[0]?.url).toBe('/ws')

    instances[0]!.simulateOpen()
    expect(instances[0]!.sent).toHaveLength(1)
    expect(JSON.parse(instances[0]!.sent[0]!)).toEqual({ type: 'register_dispatcher', name: 'Alice' })
  })

  it('FR-27/AD-8: on socket drop, reconnects once the backoff elapses, re-sending register_dispatcher and signaling onConnect', () => {
    const { manager, instances, onConnect } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    expect(onConnect).toHaveBeenCalledTimes(1)

    instances[0]!.simulateDrop()
    expect(instances).toHaveLength(1) // no reconnect attempt yet — backoff hasn't elapsed

    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)

    instances[1]!.simulateOpen()
    expect(onConnect).toHaveBeenCalledTimes(2)
    expect(JSON.parse(instances[1]!.sent[0]!)).toEqual({ type: 'register_dispatcher', name: 'Alice' })
  })

  it('doubles the backoff on repeated failures up to the cap, and resets it after a successful open', () => {
    const { manager, instances } = setup()
    manager.connect()

    // Fail three times in a row without ever opening — backoff should
    // step 1s -> 2s -> 4s (RECONNECT_BACKOFF_MULTIPLIER=2), never firing
    // early and never skipping a step.
    const initial = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
    const multiplier = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER

    instances[0]!.simulateDrop()
    vi.advanceTimersByTime(initial - 1)
    expect(instances).toHaveLength(1) // not yet
    vi.advanceTimersByTime(1)
    expect(instances).toHaveLength(2)

    instances[1]!.simulateDrop()
    vi.advanceTimersByTime(initial * multiplier - 1)
    expect(instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(instances).toHaveLength(3)

    // This time, succeed — backoff should reset to the initial value.
    instances[2]!.simulateOpen()
    instances[2]!.simulateDrop()
    vi.advanceTimersByTime(initial - 1)
    expect(instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(instances).toHaveLength(4)
  })

  it('caps the backoff at RECONNECT_BACKOFF_MAX_MS', () => {
    const { manager, instances } = setup()
    manager.connect()

    let delay: number = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS
    // Fail enough times that doubling would exceed the cap.
    for (let i = 0; i < 6; i++) {
      instances[instances.length - 1]!.simulateDrop()
      vi.advanceTimersByTime(delay)
      delay = Math.min(delay * CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER, CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS)
    }
    expect(delay).toBe(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS)

    const before = instances.length
    instances[instances.length - 1]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS - 1)
    expect(instances).toHaveLength(before) // one ms short of the cap — not yet
    vi.advanceTimersByTime(1)
    expect(instances).toHaveLength(before + 1)
  })

  it('a fresh connect() after close() restarts the backoff curve at its initial value', () => {
    const { manager, instances } = setup()
    manager.connect()

    // Escalate the backoff past its initial value with a couple of failures.
    instances[0]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    instances[1]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS * CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER)
    expect(instances).toHaveLength(3)

    manager.close()
    manager.connect() // a brand-new, unrelated connection attempt
    expect(instances).toHaveLength(4)

    // If this fresh attempt also fails, the very next reconnect must wait
    // only the initial backoff again — not the escalated value left over
    // from the previous connection's own failures.
    instances[3]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS - 1)
    expect(instances).toHaveLength(4)
    vi.advanceTimersByTime(1)
    expect(instances).toHaveLength(5)
  })

  it('AD-17: writes dispatcherId only on `registered`, clears it only on socket loss', () => {
    const { manager, instances } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    expect(manager.getDispatcherId()).toBeNull()

    instances[0]!.simulateServerMessage({ type: 'registered', dispatcherId: 'dispatcher_abc', name: 'Alice' })
    expect(manager.getDispatcherId()).toBe('dispatcher_abc')

    instances[0]!.simulateDrop()
    expect(manager.getDispatcherId()).toBeNull()
  })

  it("forwards every recognized message except `registered` and `pong` to onMessage", () => {
    const { manager, instances, onMessage } = setup()
    manager.connect()
    instances[0]!.simulateOpen()

    instances[0]!.simulateServerMessage({ type: 'registered', dispatcherId: 'd1', name: 'Alice' })
    instances[0]!.simulateServerMessage({ type: 'pong' })
    expect(onMessage).not.toHaveBeenCalled()

    const joined = { type: 'dispatcher_joined', dispatcherId: 'd2', name: 'Bob' }
    instances[0]!.simulateServerMessage(joined)
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith(joined)
  })

  it('FR-33: drops an unrecognized message type safely — counted, not thrown, never forwarded', () => {
    const { manager, instances, onMessage, onDroppedMessage } = setup()
    manager.connect()
    instances[0]!.simulateOpen()

    expect(() => instances[0]!.simulateServerMessage({ type: 'some_future_dev_message', payload: 1 })).not.toThrow()
    expect(onMessage).not.toHaveBeenCalled()
    expect(manager.getDroppedMessageCount()).toBe(1)
    expect(onDroppedMessage).toHaveBeenCalledTimes(1)

    // Malformed JSON is dropped the same safe way.
    expect(() => instances[0]!.simulateServerFrame('not json{')).not.toThrow()
    expect(manager.getDroppedMessageCount()).toBe(2)
  })

  it('sends `ping` at the keepalive interval while open, and consumes `pong` without forwarding it', () => {
    const { manager, instances } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    const sentBeforePing = instances[0]!.sent.length

    vi.advanceTimersByTime(CLIENT_THRESHOLDS.WS_KEEPALIVE_PING_MS)
    const pings = instances[0]!.sent.slice(sentBeforePing).map((raw) => JSON.parse(raw))
    expect(pings).toContainEqual({ type: 'ping' })

    expect(() => instances[0]!.simulateServerMessage({ type: 'pong' })).not.toThrow()
  })

  it('FR-30: computes ping/pong RTT from the injected clock and exposes it via getLastPingRttMs()', () => {
    let currentTime = 1_000_000
    const { manager, instances } = setup({ now: () => currentTime })
    manager.connect()
    instances[0]!.simulateOpen()
    expect(manager.getLastPingRttMs()).toBeNull() // no round trip completed yet

    vi.advanceTimersByTime(CLIENT_THRESHOLDS.WS_KEEPALIVE_PING_MS) // sends `ping` at currentTime
    currentTime += 42
    instances[0]!.simulateServerMessage({ type: 'pong' })
    expect(manager.getLastPingRttMs()).toBe(42)

    // A stray pong with no outstanding ping leaves the last reading alone.
    instances[0]!.simulateServerMessage({ type: 'pong' })
    expect(manager.getLastPingRttMs()).toBe(42)
  })

  it('FR-30: getReconnectCount() counts only reconnects that actually reopen a socket, not the first connect()', () => {
    const { manager, instances } = setup()
    manager.connect()
    expect(manager.getReconnectCount()).toBe(0) // the initial connect() is not a reconnect

    instances[0]!.simulateOpen()
    instances[0]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)
    expect(manager.getReconnectCount()).toBe(1)

    instances[1]!.simulateDrop() // never opened — still counts once the timer fires
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS * CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MULTIPLIER)
    expect(instances).toHaveLength(3)
    expect(manager.getReconnectCount()).toBe(2)
  })

  it('ignores late callbacks from a superseded (stale) socket after a reconnect', () => {
    const { manager, instances, onMessage, onConnect } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    instances[0]!.simulateServerMessage({ type: 'registered', dispatcherId: 'd1', name: 'Alice' })

    instances[0]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)
    instances[1]!.simulateOpen()
    instances[1]!.simulateServerMessage({ type: 'registered', dispatcherId: 'd2', name: 'Alice' })
    expect(manager.getDispatcherId()).toBe('d2')

    const onConnectCallsBefore = onConnect.mock.calls.length
    const droppedBefore = manager.getDroppedMessageCount()
    const reconnectCountBefore = manager.getReconnectCount()

    // Directly invoke the stale (superseded) socket's own handler
    // references — simulating a late-arriving event on an object the
    // manager has already moved on from — and assert the `socket !==
    // mySocket` guard makes every one of them a no-op.
    instances[0]!.onopen?.()
    instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'registered', dispatcherId: 'stale', name: 'Stale' }) })
    instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'dispatcher_joined', dispatcherId: 'x', name: 'Ghost' }) })
    instances[0]!.onclose?.()

    expect(onConnect).toHaveBeenCalledTimes(onConnectCallsBefore) // no extra onConnect from the stale onopen
    expect(onMessage).not.toHaveBeenCalled() // the stale dispatcher_joined must never be forwarded
    expect(manager.getDroppedMessageCount()).toBe(droppedBefore)
    expect(manager.getReconnectCount()).toBe(reconnectCountBefore) // stale onclose schedules no extra reconnect
    expect(manager.getDispatcherId()).toBe('d2') // untouched by the stale `registered`/onclose
    expect(instances).toHaveLength(2) // stale onclose creates no new socket
  })

  it('sendViewing is a send-only facade that only sends while the socket is open', () => {
    const { manager, instances } = setup()
    manager.connect()
    manager.sendViewing('truck_1') // socket still CONNECTING — no-op
    expect(instances[0]!.sent).toHaveLength(0)

    instances[0]!.simulateOpen()
    manager.sendViewing('truck_1')
    manager.sendViewing(null)
    const sent = instances[0]!.sent.map((raw) => JSON.parse(raw))
    expect(sent).toContainEqual({ type: 'viewing_truck', truckId: 'truck_1' })
    expect(sent).toContainEqual({ type: 'viewing_truck', truckId: null })
  })

  it('register(): before the socket opens, just updates the mutable current name — the pending auto-register-on-open send picks it up, never silently dropped', () => {
    const { manager, instances } = setup()
    manager.connect()
    expect(instances[0]!.readyState).toBe(0) // still CONNECTING

    manager.register('Bob') // no socket to send on yet
    expect(instances[0]!.sent).toHaveLength(0) // nothing sent while not open

    instances[0]!.simulateOpen()
    expect(instances[0]!.sent).toHaveLength(1)
    expect(JSON.parse(instances[0]!.sent[0]!)).toEqual({ type: 'register_dispatcher', name: 'Bob' })
  })

  it('register(): on an already-open socket, sends register_dispatcher immediately with the new name', () => {
    const { manager, instances } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    const sentBefore = instances[0]!.sent.length

    manager.register('Carol')
    const sentAfter = instances[0]!.sent.slice(sentBefore).map((raw) => JSON.parse(raw))
    expect(sentAfter).toContainEqual({ type: 'register_dispatcher', name: 'Carol' })
  })

  it('register(): a name set before open (or via a prior register()) survives a later reconnect — the mutable current name, not the construction-time default, drives every future auto-register', () => {
    const { manager, instances } = setup() // constructed with dispatcherName: 'Alice'
    manager.connect()
    instances[0]!.simulateOpen()
    manager.register('Dana')

    instances[0]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)
    instances[1]!.simulateOpen()
    expect(JSON.parse(instances[1]!.sent[0]!)).toEqual({ type: 'register_dispatcher', name: 'Dana' })
  })

  it("code-review patch: register('') is a no-op — doesn't send an explicit empty name when open, and doesn't overwrite the durable current name for a future auto-register", () => {
    const { manager, instances } = setup() // constructed with dispatcherName: 'Alice'
    manager.connect()
    instances[0]!.simulateOpen()
    const sentBefore = instances[0]!.sent.length

    manager.register('')
    expect(instances[0]!.sent).toHaveLength(sentBefore) // nothing new sent

    instances[0]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(instances).toHaveLength(2)
    instances[1]!.simulateOpen()
    // The construction-time name survives — register('') never overwrote
    // currentDispatcherName with an empty string.
    expect(JSON.parse(instances[1]!.sent[0]!)).toEqual({ type: 'register_dispatcher', name: 'Alice' })
  })

  it("code-review patch: register('   ') (whitespace-only) is a no-op — the empty-name guard checks trimmed content, not just the exact empty string", () => {
    const { manager, instances } = setup() // constructed with dispatcherName: 'Alice'
    manager.connect()
    instances[0]!.simulateOpen()
    const sentBefore = instances[0]!.sent.length

    manager.register('   ')
    expect(instances[0]!.sent).toHaveLength(sentBefore) // nothing new sent

    instances[0]!.simulateDrop()
    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    instances[1]!.simulateOpen()
    // The construction-time name survives — register('   ') never
    // overwrote currentDispatcherName with whitespace.
    expect(JSON.parse(instances[1]!.sent[0]!)).toEqual({ type: 'register_dispatcher', name: 'Alice' })
  })

  it('close() tears the connection down for good — no further reconnect attempts', () => {
    const { manager, instances } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    manager.close()
    expect(instances[0]!.readyState).toBe(WS_CLOSED)

    vi.advanceTimersByTime(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_MAX_MS * 4)
    expect(instances).toHaveLength(1)
    expect(manager.getDispatcherId()).toBeNull()
  })
})

describe('getWsSendFacade / setWsSendFacade', () => {
  afterEach(() => {
    resetWsSendFacadeForTests()
  })

  it('returns null before app/ has wired anything in (a widget rendering before bootstrap runs never crashes)', () => {
    expect(getWsSendFacade()).toBeNull()
  })

  it('returns exactly what was set, narrowed to {register, sendViewing} — the widened AD-1 facade', () => {
    const register = vi.fn()
    const sendViewing = vi.fn()
    setWsSendFacade({ register, sendViewing })

    const facade = getWsSendFacade()
    expect(facade).not.toBeNull()
    facade!.register('Alice')
    facade!.sendViewing('truck_1')
    expect(register).toHaveBeenCalledWith('Alice')
    expect(sendViewing).toHaveBeenCalledWith('truck_1')
  })

  it('a real WsManager satisfies the facade shape — register/sendViewing work when set directly from createWsManager()', () => {
    vi.useFakeTimers()
    const { manager, instances } = setup()
    manager.connect()
    instances[0]!.simulateOpen()
    setWsSendFacade({ register: manager.register, sendViewing: manager.sendViewing })

    getWsSendFacade()!.register('Eve')
    getWsSendFacade()!.sendViewing('truck_2')

    const sent = instances[0]!.sent.map((raw) => JSON.parse(raw))
    expect(sent).toContainEqual({ type: 'register_dispatcher', name: 'Eve' })
    expect(sent).toContainEqual({ type: 'viewing_truck', truckId: 'truck_2' })
    vi.useRealTimers()
  })
})
