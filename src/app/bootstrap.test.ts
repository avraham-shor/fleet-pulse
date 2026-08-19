// FleetPulse — composition-root bootstrap tests (AD-1)
//
// Node environment (no DOM needed) — mocks the two browser globals this
// module's defaults reach for (`fetch`, `EventSource`; Node has no global
// `EventSource` at all — confirmed empirically, not assumed) and vitest's
// fake timers so the staleness interval never leaks a real repeating timer
// across tests. Each test resets Vitest's module registry so
// `bootstrap.ts`'s own module-scoped singleton (and the store singleton it
// wires) start fresh — `bootstrap.ts` intentionally has no per-instance
// constructor, only a memoized accessor, so isolating tests means
// isolating the module graph.

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
  vi.stubGlobal('EventSource', FakeEventSource)
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
