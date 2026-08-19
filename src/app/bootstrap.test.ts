// FleetPulse — composition-root bootstrap tests (AD-1)
//
// Node environment (no DOM needed) — mocks the three browser globals this
// module's defaults reach for (`fetch`, `EventSource`, `WebSocket`; Node
// has no global `EventSource` at all — confirmed empirically, not assumed;
// Node 24 does ship a global `WebSocket`, but its real implementation
// rejects the manager's relative `/ws` URL, so it's stubbed the same way)
// and vitest's fake timers so the staleness interval never leaks a real
// repeating timer across tests. Each test resets Vitest's module registry
// so `bootstrap.ts`'s own module-scoped singleton (and the store/ws-manager
// singletons it wires) start fresh — `bootstrap.ts` intentionally has no
// per-instance constructor, only a memoized accessor, so isolating tests
// means isolating the module graph.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Truck } from '../contract/rest.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close() {
    // no-op — nothing in these tests exercises reconnect/close behavior,
    // that's sse-manager.test.ts's job.
  }
}

const WS_OPEN = 1
const WS_CLOSED = 3

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    if (this.readyState === WS_CLOSED) return
    this.readyState = WS_CLOSED
    this.onclose?.()
  }

  // --- test helpers, not part of the real WebSocket API ------------------
  simulateOpen() {
    this.readyState = WS_OPEN
    this.onopen?.()
  }

  simulateServerMessage(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  simulateDrop() {
    this.close()
  }
}

function makeTruck(overrides: Partial<Truck> = {}): Truck {
  return {
    truckId: 'truck_1',
    status: 'active',
    lat: 32.1,
    lng: 34.8,
    speed: 40,
    fuel: 70,
    engineTemp: 75,
    mileage: 1_000,
    timestamp: 0,
    routeId: null,
    ...overrides,
  }
}

function makeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
  FakeWebSocket.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function freshBootstrapModule() {
  vi.resetModules()
  return import('./bootstrap.ts')
}

/** Same fresh-module-graph reset as `freshBootstrapModule()`, but also
 * hands back `transport/ws-manager.ts`'s exports from the *same* graph —
 * needed to reach `getWsSendFacade()` and prove it's wired to the exact
 * `wsManager` instance `bootstrap.ts` constructed (not some unrelated
 * fresh instance from a second, independent `import()`). */
async function freshBootstrapWithWs() {
  vi.resetModules()
  const bootstrapModule = await import('./bootstrap.ts')
  const wsManagerModule = await import('../transport/ws-manager.ts')
  return { ...bootstrapModule, ...wsManagerModule }
}

describe('getBootstrap', () => {
  it('StrictMode safety: two calls perform the wiring exactly once — one getFleet(), one EventSource, same instance returned', async () => {
    const trucks = [makeTruck()]
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, trucks))
    vi.stubGlobal('fetch', fetchMock)

    const { getBootstrap } = await freshBootstrapModule()
    const first = getBootstrap()
    const second = getBootstrap() // mirrors StrictMode's dev-only double-invoke
    expect(first).toBe(second)

    await vi.advanceTimersByTimeAsync(0) // let the getFleet() promise chain settle

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(first.store.getState().fleet.trucks['truck_1']).toEqual(trucks[0])
  })

  it('starts the STALENESS_TICK_MS interval — health.nowMs advances on its own without a manual tick call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapModule()
    const { store } = getBootstrap()
    const before = store.getState().health.nowMs

    // Derived from the constant itself (not a magic literal) so a
    // regression in STALENESS_TICK_MS's value would still be caught here.
    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.STALENESS_TICK_MS * 2)

    expect(store.getState().health.nowMs).toBeGreaterThan(before)
  })

  it('a fatal (non-retryable) fleet-fetch failure flips fetchStatus to error via the real wiring', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(500, { error: 'boom', message: 'boom' })))
    const { getBootstrap } = await freshBootstrapModule()
    const { store } = getBootstrap()

    await vi.advanceTimersByTimeAsync(0)

    expect(store.getState().fleet.fetchStatus).toBe('error')
  })
})

describe('getBootstrap: presence wiring (FR-16..19, AD-8)', () => {
  it('connects the WS socket eagerly, no blocking gate — mirrors sseManager.connect()', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    getBootstrap()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('FR-16: auto-registers on open with no name, and getWsSendFacade().register() re-registers the already-open socket under the chosen name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap, getWsSendFacade } = await freshBootstrapWithWs()
    getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    expect(JSON.parse(FakeWebSocket.instances[0]!.sent[0]!)).toEqual({ type: 'register_dispatcher' })

    getWsSendFacade()!.register('Alice')
    const sent = FakeWebSocket.instances[0]!.sent.map((raw) => JSON.parse(raw))
    expect(sent).toContainEqual({ type: 'register_dispatcher', name: 'Alice' })
  })

  it('wires dispatcher_joined/_left directly into the presence slice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'dispatcher_joined', dispatcherId: 'dispatcher_1', name: 'Alice' })
    expect(store.getState().presence.dispatchers['dispatcher_1']?.name).toBe('Alice')

    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'dispatcher_left', dispatcherId: 'dispatcher_1' })
    expect(store.getState().presence.dispatchers['dispatcher_1']).toBeUndefined()
  })

  it("wires dispatcher_viewing through the coalescing scheduler, not a direct commit", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'dispatcher_joined', dispatcherId: 'dispatcher_1', name: 'Alice' })
    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'dispatcher_viewing', dispatcherId: 'dispatcher_1', truckId: 'truck_5' })

    // Not applied yet — dispatcher_viewing rides the same coalescing
    // scheduler as pipeline commits (AD-5), it doesn't commit synchronously.
    expect(store.getState().presence.dispatchers['dispatcher_1']?.viewingTruckId).toBeNull()

    await vi.advanceTimersByTimeAsync(1_000 / CLIENT_THRESHOLDS.RENDER_COALESCE_MAX_COMMITS_PER_SEC)
    expect(store.getState().presence.dispatchers['dispatcher_1']?.viewingTruckId).toBe('truck_5')
  })

  it('AD-8: onConnect resets presence before the server replay rebuilds it — a reconnect leaves no stale peer behind', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'dispatcher_joined', dispatcherId: 'dispatcher_stale', name: 'StalePeer' })
    expect(Object.keys(store.getState().presence.dispatchers)).toEqual(['dispatcher_stale'])

    FakeWebSocket.instances[0]!.simulateDrop()
    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1]!.simulateOpen() // fires onConnect -> resetPresence()
    expect(store.getState().presence.dispatchers).toEqual({})

    // The server's replay-on-register rebuild: only the still-present peer
    // comes back — the stale one from before the drop never reappears on
    // its own.
    FakeWebSocket.instances[1]!.simulateServerMessage({ type: 'dispatcher_joined', dispatcherId: 'dispatcher_live', name: 'LivePeer' })
    expect(Object.keys(store.getState().presence.dispatchers)).toEqual(['dispatcher_live'])
  })

  it('FR-19: sweeps a stale presence entry on the same staleness tick that drives the effective-trust selector', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'dispatcher_joined', dispatcherId: 'dispatcher_1', name: 'Alice' })
    expect(store.getState().presence.dispatchers['dispatcher_1']).toBeDefined()

    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.PRESENCE_LIVENESS_TIMEOUT_MS + CLIENT_THRESHOLDS.STALENESS_TICK_MS)

    expect(store.getState().presence.dispatchers['dispatcher_1']).toBeUndefined()
  })

  it('FR-33: an unhandled recognized WS message type (e.g. fleet_reset) is safely ignored by this wiring, never a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    expect(() => FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'fleet_reset' })).not.toThrow()
    expect(store.getState().presence.dispatchers).toEqual({})
  })
})
