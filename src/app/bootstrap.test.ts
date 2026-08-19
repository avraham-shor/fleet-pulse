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
import type { Route, Truck } from '../contract/rest.ts'
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

function makeResponseWithHeader(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  } as unknown as Response
}

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    routeId: 'route_1',
    truckId: 'truck_1',
    status: 'assigned',
    version: 1,
    destination: 'Warehouse A',
    createdBy: { dispatcherId: 'dispatcher_1', name: 'Alice' },
    createdAt: 1_000,
    updatedAt: 1_000,
    updatedBy: { dispatcherId: 'dispatcher_1', name: 'Alice' },
    ...overrides,
  }
}

/** Routes fetch responses by URL — `getFleet()` and `getRoutes()` share the
 * same global `fetch` stub, so a test that cares about both endpoints'
 * responses independently needs this instead of a single blanket mock. */
function makeUrlAwareFetch(byUrl: { fleet?: Response; routes?: Response }) {
  return vi.fn((input: unknown) => {
    const url = String(input)
    if (url.includes('/api/routes')) return Promise.resolve(byUrl.routes ?? makeResponse(200, []))
    return Promise.resolve(byUrl.fleet ?? makeResponse(200, []))
  })
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

  it('FR-33: an unrecognized WS message type is safely ignored (dropped by ws-manager itself before reaching this wiring), never a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    expect(() => FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'not_a_real_message_type' })).not.toThrow()
    expect(store.getState().presence.dispatchers).toEqual({})
  })
})

describe('getBootstrap: routes wiring (FR-10..15, FR-34, AD-16, AD-7)', () => {
  it('wires route_assigned/_updated/_reassigned directly into the routes slice (direct commit, not the coalescing scheduler)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'route_assigned', route: makeRoute({ version: 1 }) })
    // Not coalesced — applied synchronously, no timer advance needed.
    expect(store.getState().routes.routes['route_1']?.status).toBe('assigned')

    FakeWebSocket.instances[0]!.simulateServerMessage({
      type: 'route_updated',
      route: makeRoute({ version: 2, status: 'in-progress' }),
    })
    expect(store.getState().routes.routes['route_1']?.status).toBe('in-progress')

    FakeWebSocket.instances[0]!.simulateServerMessage({
      type: 'route_reassigned',
      route: makeRoute({ version: 3, status: 'in-progress', truckId: 'truck_2' }),
    })
    expect(store.getState().routes.routes['route_1']?.truckId).toBe('truck_2')
  })

  it("FR-34's hydration gap fix: the first WS connection populates routesSlice from GET /api/routes before any live echo arrives", async () => {
    const fetchMock = makeUrlAwareFetch({ routes: makeResponse(200, [makeRoute()]) })
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    expect(store.getState().routes.routes['route_1']).toBeUndefined() // not yet — onConnect hasn't fired

    FakeWebSocket.instances[0]!.simulateOpen()
    await vi.advanceTimersByTimeAsync(0) // let getRoutes() resolve

    expect(store.getState().routes.routes['route_1']?.destination).toBe('Warehouse A')
  })

  it('hydrateRoutes() also runs on reconnect, catching up on anything that changed while disconnected', async () => {
    const fetchMock = makeUrlAwareFetch({ routes: makeResponse(200, [makeRoute({ version: 1 })]) })
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().routes.routes['route_1']?.version).toBe(1)

    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/routes')) return Promise.resolve(makeResponse(200, [makeRoute({ version: 2, status: 'in-progress' })]))
      return Promise.resolve(makeResponse(200, []))
    })

    FakeWebSocket.instances[0]!.simulateDrop()
    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1]!.simulateOpen()
    await vi.advanceTimersByTimeAsync(0)

    expect(store.getState().routes.routes['route_1']?.version).toBe(2)
    expect(store.getState().routes.routes['route_1']?.status).toBe('in-progress')
  })

  it('closes the review finding (iteration 3): apiClient.getRoutes() is called exactly once on the very first connection, not twice', async () => {
    const fetchMock = makeUrlAwareFetch({})
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await freshBootstrapWithWs()
    getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    await vi.advanceTimersByTimeAsync(0)

    const routesCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/routes'))
    expect(routesCalls).toHaveLength(1)
  })

  it('best-effort: a failed getRoutes() call does nothing further — no throw, routes slice just stays empty for the next echo to fill', async () => {
    const fetchMock = makeUrlAwareFetch({ routes: makeResponse(500, { error: 'boom', message: 'boom' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    expect(() => FakeWebSocket.instances[0]!.simulateOpen()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)

    expect(store.getState().routes.routes).toEqual({})
  })

  it('AD-7: hydrateRoutes goes through api-client — the same global fetch stub api-client itself uses, never a second-source fetch call site', async () => {
    const fetchMock = makeUrlAwareFetch({ routes: makeResponse(200, [makeRoute()]) })
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await freshBootstrapWithWs()
    getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledWith('/api/routes')
  })
})

describe('getBootstrap: health slice wiring (AD-9, FR-25, FR-26)', () => {
  it('AD-9: SSE onConnectionChange(false) sets telemetryStreamDown immediately; recovering only clears it after the hysteresis window', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapModule()
    const { store } = getBootstrap()

    expect(FakeEventSource.instances).toHaveLength(1)
    FakeEventSource.instances[0]!.onopen?.()
    expect(store.getState().health.telemetryStreamDown).toBe(false)

    FakeEventSource.instances[0]!.onerror?.()
    expect(store.getState().health.telemetryStreamDown).toBe(true)

    // Reconnect and recover — the condition must not clear on the spot.
    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS)
    expect(FakeEventSource.instances).toHaveLength(2)
    FakeEventSource.instances[1]!.onopen?.()
    expect(store.getState().health.telemetryStreamDown).toBe(true) // still down — hysteresis pending

    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS + CLIENT_THRESHOLDS.STALENESS_TICK_MS)
    expect(store.getState().health.telemetryStreamDown).toBe(false)
  })

  it('AD-9: fleetFetchFailing is polled from apiClient.getBreakerState() on the staleness tick after the breaker opens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponseWithHeader(503, { error: 'fleet_unavailable', message: 'busy' }, { 'Retry-After': '1' }))
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await freshBootstrapModule()
    const { store } = getBootstrap()

    // Exhaust the initial getFleet() call's own FR-24 retry loop (three
    // consecutive 503s, each followed by a Retry-After-honoring sleep)
    // until FR-25's threshold opens the breaker.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getState().fleet.fetchStatus).toBe('error')
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(CLIENT_THRESHOLDS.BREAKER_FAILURE_THRESHOLD)

    // The poll happens on the staleness tick, already fired repeatedly
    // during the 5s advance above — fleetFetchFailing should already
    // reflect the now-open breaker.
    expect(store.getState().health.fleetFetchFailing).toBe(true)
  })
})

describe('getBootstrap: transport obs counters wiring (FR-30, story 10)', () => {
  it('populates obs.transportCounters from the real sse/ws managers on the existing staleness tick — no new interval, no new fetch path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    // Starts at the obsSlice defaults — nothing populated before the first tick.
    expect(store.getState().obs.transportCounters).toEqual({
      sseDroppedMessages: 0,
      sseReconnects: 0,
      sseEventsPerSecond: 0,
      wsDroppedMessages: 0,
      wsReconnects: 0,
      wsLastPingRttMs: null,
    })

    // Drive real activity through the real managers: an SSE dropped frame
    // and a WS dropped frame, checked on the very next tick (while the SSE
    // frame is still inside its rolling events/sec window)...
    FakeEventSource.instances[0]!.onmessage?.({ data: 'not json{' })
    FakeWebSocket.instances[0]!.simulateOpen()
    FakeWebSocket.instances[0]!.onmessage?.({ data: 'not json{' })
    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.STALENESS_TICK_MS)

    const firstTickCounters = store.getState().obs.transportCounters
    expect(firstTickCounters.sseDroppedMessages).toBe(1)
    expect(firstTickCounters.wsDroppedMessages).toBe(1)
    expect(firstTickCounters.sseEventsPerSecond).toBeGreaterThan(0)
    expect(firstTickCounters.wsLastPingRttMs).toBeNull() // no ping round trip yet

    // ...then a completed ping/pong round trip, checked on a later tick —
    // the RTT getter's own value, not re-derived here.
    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.WS_KEEPALIVE_PING_MS) // fires one ping
    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'pong' })
    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.STALENESS_TICK_MS)

    expect(store.getState().obs.transportCounters.wsLastPingRttMs).not.toBeNull()
  })
})

describe('getBootstrap: truck_alert wiring (FR-32, CM1)', () => {
  it('FR-32: a truck_alert WS message lands in the fleet slice via addTruckAlert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    FakeWebSocket.instances[0]!.simulateServerMessage({
      type: 'truck_alert',
      truckId: 'truck_1',
      message: 'Check tire pressure',
      dispatcherId: 'dispatcher_1',
      dispatcherName: 'Alice',
      timestamp: 1_000,
    })

    expect(store.getState().fleet.alerts['truck_1']?.toArray()).toEqual([
      { truckId: 'truck_1', message: 'Check tire pressure', dispatcherId: 'dispatcher_1', dispatcherName: 'Alice', timestamp: 1_000 },
    ])
  })

  it('CM1: a truck_alert for an unrecognized truckId upserts a stub truck instead of being dropped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [makeTruck({ truckId: 'truck_1' })])))
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()
    await vi.advanceTimersByTimeAsync(0)

    FakeWebSocket.instances[0]!.simulateOpen()
    FakeWebSocket.instances[0]!.simulateServerMessage({
      type: 'truck_alert',
      truckId: 'truck_99',
      message: 'Unrecognized truck',
      dispatcherId: 'dispatcher_1',
      dispatcherName: 'Alice',
      timestamp: 2_000,
    })

    expect(store.getState().fleet.trucks['truck_99']).toBeDefined()
    expect(store.getState().fleet.alerts['truck_99']?.toArray()).toHaveLength(1)
    // The already-known truck's own roster entry is untouched.
    expect(store.getState().fleet.trucks['truck_1']).toBeDefined()
  })
})

describe('getBootstrap: fleet_reset wiring (AD-8, FR-33)', () => {
  it('FR-33: runs the full AD-8 sequence — pipeline/telemetry/obs/alerts/routes/presence wiped, routes re-hydrated', async () => {
    const fetchMock = makeUrlAwareFetch({ routes: makeResponse(200, [makeRoute()]) })
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    FakeWebSocket.instances[0]!.simulateOpen()
    await vi.advanceTimersByTimeAsync(0) // let onConnect's hydrateRoutes() resolve
    expect(store.getState().routes.routes['route_1']).toBeDefined()

    // Seed state fleet_reset is supposed to wipe.
    store.getState().applyTelemetryCommits([
      { truckId: 'truck_1', signals: [{ signal: 'speed', live: { value: 60, trust: 'trusted', readingTs: 0, arrivalTs: 0 }, historyEntries: [] }] },
    ])
    store.getState().pushAnomalies([{ ruleId: 'r1', truckId: 'truck_1', rawValue: 999, readingTs: 0, arrivalTs: 0 }])
    store.getState().dispatcherJoined('dispatcher_2', 'Bob')
    store.getState().addTruckAlert({
      truckId: 'truck_1',
      message: 'Check tire pressure',
      dispatcherId: 'dispatcher_1',
      dispatcherName: 'Alice',
      timestamp: 1_000,
    })
    expect(store.getState().telemetry.trucks['truck_1']).toBeDefined()
    expect(store.getState().obs.anomalyLog.size()).toBe(1)
    expect(Object.keys(store.getState().presence.dispatchers)).toContain('dispatcher_2')
    expect(store.getState().fleet.alerts['truck_1']?.size()).toBe(1)

    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'fleet_reset' })

    // Synchronous half of the sequence.
    expect(store.getState().telemetry.trucks).toEqual({})
    expect(store.getState().obs.anomalyLog.size()).toBe(0)
    expect(store.getState().routes.routes).toEqual({})
    expect(store.getState().presence.dispatchers).toEqual({})
    // Code-review finding: this story's own per-truck alert buffers are
    // session-scoped derived state too — the same category as the anomaly
    // log — and must be wiped alongside it.
    expect(store.getState().fleet.alerts).toEqual({})

    // Re-hydration (async GET /api/routes) catches routes back up.
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().routes.routes['route_1']).toBeDefined()
  })

  it("FR-33: an open circuit gets an immediate probe on fleet_reset — forceNextProbe() plus the getFleet() call that actually performs it", async () => {
    let attempt = 0
    const fetchMock = vi.fn((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/routes')) return Promise.resolve(makeResponse(200, []))
      attempt += 1
      if (attempt <= CLIENT_THRESHOLDS.BREAKER_FAILURE_THRESHOLD) {
        return Promise.resolve(makeResponseWithHeader(503, { error: 'fleet_unavailable', message: 'busy' }, { 'Retry-After': '1' }))
      }
      return Promise.resolve(makeResponse(200, [makeTruck({ truckId: 'truck_1' })]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await freshBootstrapWithWs()
    const { store } = getBootstrap()

    // Exhaust the initial retry loop until the breaker opens.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getState().fleet.fetchStatus).toBe('error')

    FakeWebSocket.instances[0]!.simulateOpen()
    await vi.advanceTimersByTimeAsync(0)

    FakeWebSocket.instances[0]!.simulateServerMessage({ type: 'fleet_reset' })
    await vi.advanceTimersByTimeAsync(0) // let the forced probe's getFleet() resolve

    expect(store.getState().fleet.trucks['truck_1']).toBeDefined()
    expect(store.getState().fleet.fetchStatus).toBe('ready')

    // AD-9/FR-26 coverage gap (code review): the successful probe closed the
    // breaker, but `health.fleetFetchFailing` only follows it once the
    // staleness-tick poll observes `getBreakerState() === 'closed'` and the
    // hysteresis window then elapses — never on the spot.
    expect(store.getState().health.fleetFetchFailing).toBe(true) // not yet — hysteresis pending
    await vi.advanceTimersByTimeAsync(CLIENT_THRESHOLDS.BANNER_CLEAR_HYSTERESIS_MS + CLIENT_THRESHOLDS.STALENESS_TICK_MS)
    expect(store.getState().health.fleetFetchFailing).toBe(false)
  })
})
