// @vitest-environment jsdom
// FleetPulse — App shell integration test (AD-1, AD-6, FR-28)
//
// Exercises the real production wiring end to end: the side-effect import
// in App.tsx that registers FleetOverview, plus the `useEffect` that calls
// `getBootstrap()`. Neither is exercised together anywhere else —
// `registry.test.ts` only registers a dummy widget; `FleetOverview.test.tsx`
// renders `<FleetOverview />` directly, bypassing the registry/shell
// entirely; `bootstrap.test.ts` never imports `App.tsx`. Removing either
// the side-effect import (the widget silently vanishes from the shell) or
// the `useEffect` (bootstrap never fires — the app is stuck on "Loading
// fleet…" forever) would both ship with every other test file still green.
//
// Mocks the same browser globals `bootstrap.test.ts` does (`fetch`,
// `EventSource`, `WebSocket`) and resets Vitest's module registry per test
// so the module-scoped store/registry singletons this story wires together
// all start fresh.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Truck } from '../contract/rest.ts'

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
    // no-op — reconnect/close behavior is sse-manager.test.ts's job.
  }
}

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
    // no-op — reconnect/close behavior is ws-manager.test.ts's job.
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
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function freshApp() {
  vi.resetModules()
  const { default: App } = await import('./App.tsx')
  return App
}

describe('App', () => {
  it('wires bootstrap + the widget registry together: loading, then the live fleet grid populated from the real (mocked) fetch', async () => {
    const trucks = [makeTruck({ truckId: 'truck_1' }), makeTruck({ truckId: 'truck_2', status: 'idle' })]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, trucks)))

    const App = await freshApp()
    const { rerender } = render(<App />)

    // Proves the `useEffect` really did call `getBootstrap()` (which is
    // what starts the fetch): before it resolves, this loading text is
    // coming from the *registered* widget, mounted by App's own shell via
    // `getWidgets()` — not a hardcoded reference to FleetOverview.
    expect(screen.getByText('Loading fleet…')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(0) // let getFleet() resolve and commit
    rerender(<App />)

    // Proves the side-effect import really did register FleetOverview:
    // its post-fetch content (the roster + the SVG grid) is now present
    // inside the shell, not just in a test that renders it directly.
    // Scoped to `span` (FleetOverview's roster row markup): the presence
    // widget's own viewing-selector also renders each truck id, as an
    // `<option>`, in the same shell — this disambiguates the two.
    expect(screen.getByText('truck_1', { selector: 'span' })).toBeTruthy()
    expect(screen.getByText('truck_2', { selector: 'span' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Fleet position grid' })).toBeTruthy()
  })

  it('FR-24/25: a fatal fleet-fetch failure surfaces the widget\'s own inline error state through the real wiring, never a modal (CM2)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(500, { error: 'boom', message: 'boom' })))

    const App = await freshApp()
    const { rerender } = render(<App />)
    await vi.advanceTimersByTimeAsync(0)
    rerender(<App />)

    expect(screen.getByRole('alert').textContent).toContain('unavailable')
  })

  it('AD-6: the presence widget mounts through the shell via its own side-effect import — no edit to FleetOverview needed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))

    const App = await freshApp()
    render(<App />)
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByLabelText('Your name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Register' })).toBeTruthy()
    expect(screen.getByText('No other dispatchers active')).toBeTruthy()
  })

  it('AD-6: the routes widget mounts through the shell via its own side-effect import — no edit to FleetOverview/PresencePanel needed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(200, [])))

    const App = await freshApp()
    render(<App />)
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByRole('heading', { name: 'Create route' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Active routes' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Audit trail' })).toBeTruthy()
    expect(screen.getByText('No routes yet')).toBeTruthy()
  })
})
