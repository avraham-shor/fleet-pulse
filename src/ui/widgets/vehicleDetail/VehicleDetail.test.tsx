// @vitest-environment jsdom
// FleetPulse — VehicleDetail widget tests (FR-20, FR-21, FR-22, FR-23,
// FR-32, AD-3, AD-15, AD-7)
//
// Same isolation convention as RoutesPanel.test.tsx: this widget subscribes
// to the *production* store singleton and constructs its own module-scope
// `vehicleDetailApiClient` at import time (reading the stubbed global
// `fetch`/WS send facade current at that moment) — isolating one test from
// the next means resetting Vitest's module registry and re-importing fresh,
// stubbing `fetch`/the WS send facade *before* that import.
//
// Alert send is pessimistic (AD-7): a mocked 201 never writes the alert
// into the store directly — every "does the alert appear" assertion goes
// through an explicit `store.getState().addTruckAlert(...)`, exactly like
// the real `truck_alert` WS echo `app/bootstrap.ts` wires in.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Route, Truck, TruckAlert } from '../../../contract/rest.ts'

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

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    routeId: 'route_1',
    truckId: 'truck_1',
    status: 'assigned',
    version: 1,
    destination: 'Warehouse A',
    createdBy: { dispatcherId: 'dispatcher_other', name: 'Bob' },
    createdAt: 1_000,
    updatedAt: 1_000,
    updatedBy: { dispatcherId: 'dispatcher_other', name: 'Bob' },
    ...overrides,
  }
}

function makeAlert(overrides: Partial<TruckAlert> = {}): TruckAlert {
  return {
    truckId: 'truck_1',
    message: 'Check tire pressure',
    dispatcherId: 'dispatcher_1',
    dispatcherName: 'Alice',
    timestamp: 1_000,
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

async function freshHarness(options: { fetchImpl?: ReturnType<typeof vi.fn>; dispatcherId?: string | null } = {}) {
  vi.resetModules()
  if (options.fetchImpl) vi.stubGlobal('fetch', options.fetchImpl)
  const { getFleetPulseStore } = await import('../../../store/store.ts')
  const { setWsSendFacade } = await import('../../../transport/ws-manager.ts')
  const dispatcherId = 'dispatcherId' in options ? options.dispatcherId! : 'dispatcher_abc'
  setWsSendFacade({ register: vi.fn(), sendViewing: vi.fn(), getDispatcherId: () => dispatcherId })
  const { VehicleDetail } = await import('./VehicleDetail.tsx')
  return { store: getFleetPulseStore(), VehicleDetail }
}

afterEach(() => {
  cleanup()
})

describe('VehicleDetail — placeholder + selection (FR-20)', () => {
  it('renders a placeholder when no truck is selected', async () => {
    const { VehicleDetail } = await freshHarness()
    render(<VehicleDetail />)
    expect(screen.getByText(/select a truck/i)).toBeTruthy()
  })

  it('opens once selectTruck is dispatched, showing the truck id in the heading', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', status: 'active' })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    expect(screen.getByRole('heading', { name: /truck_1/ })).toBeTruthy()
  })

  it('opens even for a stub truck upserted by an alert (CM1) — the roster snapshot is display-only here', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_99' }))
    store.getState().selectTruck('truck_99')

    render(<VehicleDetail />)
    expect(screen.getByRole('heading', { name: /truck_99/ })).toBeTruthy()
  })
})

describe('VehicleDetail — signals (FR-20, FR-21, FR-5, AD-3)', () => {
  it('FR-20/FR-21: a live reading shows its value, trust badge, and a sparkline over bounded history', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')
    store.getState().tickStaleness(0)
    store.getState().applyTelemetryCommits([
      {
        truckId: 'truck_1',
        signals: [
          {
            signal: 'speed',
            live: { value: 55, trust: 'trusted', readingTs: 0, arrivalTs: 0 },
            historyEntries: [
              { value: 40, trust: 'trusted', readingTs: 0, arrivalTs: 0 },
              { value: 55, trust: 'trusted', readingTs: 1_000, arrivalTs: 0 },
            ],
          },
        ],
      },
    ])

    render(<VehicleDetail />)
    const speedCard = screen.getByTestId('signal-speed')
    expect(speedCard.textContent).toContain('55')
    expect(speedCard.textContent).toContain('km/h')
    expect(speedCard.textContent).toContain('Trusted')
    expect(screen.getByTestId('sparkline-speed')).toBeTruthy()
  })

  it('FR-5: a signal with no reading yet shows "No trusted reading yet", never a guess, and no sparkline', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    const fuelCard = screen.getByTestId('signal-fuel')
    expect(fuelCard.textContent).toContain('No trusted reading yet')
    expect(fuelCard.querySelector('[data-testid="sparkline-fuel"]')).toBeNull()
  })

  it('AD-3: reads speed/fuel/temperature/mileage via the telemetry slice, not the fleet roster snapshot', async () => {
    const { store, VehicleDetail } = await freshHarness()
    // The roster snapshot claims speed 999 — if the widget ever read this
    // directly (the boundary this story forbids), this assertion would
    // catch it. No telemetry commit exists, so the live selector must show
    // "no reading yet" regardless of the roster snapshot's own numbers.
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', speed: 999, fuel: 999, engineTemp: 999, mileage: 999 })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    expect(screen.getByTestId('signal-speed').textContent).toContain('No trusted reading yet')
    expect(screen.getByTestId('signal-fuel').textContent).toContain('No trusted reading yet')
    expect(screen.getByTestId('signal-temperature').textContent).toContain('No trusted reading yet')
    expect(screen.getByTestId('signal-mileage').textContent).toContain('No trusted reading yet')
  })

  it('AD-9: a signal shows the degraded badge when the health slice reports either condition down', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')
    store.getState().applyTelemetryCommits([
      { truckId: 'truck_1', signals: [{ signal: 'speed', live: { value: 40, trust: 'trusted', readingTs: 0, arrivalTs: 0 }, historyEntries: [] }] },
    ])
    store.getState().setTelemetryStreamDown(true, 0)

    render(<VehicleDetail />)
    expect(screen.getByTestId('signal-speed').textContent).toContain('Degraded')
  })
})

describe('VehicleDetail — route details (FR-23)', () => {
  it('shows destination and status for an active route', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')
    store.getState().applyRouteAssigned(makeRoute({ truckId: 'truck_1', destination: 'Port A', status: 'in-progress' }))

    render(<VehicleDetail />)
    const routeDetails = screen.getByTestId('route-details')
    expect(routeDetails.textContent).toContain('Port A')
    expect(routeDetails.textContent).toContain('in-progress')
    expect(routeDetails.textContent).toContain('Bob')
  })

  it('shows a clear empty state when the truck has no active route', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    expect(screen.getByText('No active route')).toBeTruthy()
  })
})

describe('VehicleDetail — alert send (FR-22, FR-32, NFR-7, AD-7)', () => {
  it('rejects an empty/whitespace message before submission — no request sent', async () => {
    const fetchImpl = vi.fn()
    const { store, VehicleDetail } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    fireEvent.change(screen.getByLabelText('Send alert'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send alert' }))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('a valid message posts via sendTruckAlert with the trimmed message and the dispatcher header (AD-7)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(201, { truckId: 'truck_1', message: 'Low fuel', dispatcherId: 'dispatcher_abc', dispatcherName: 'Alice', timestamp: 5_000 }),
    )
    const { store, VehicleDetail } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    fireEvent.change(screen.getByLabelText('Send alert'), { target: { value: '  Low fuel  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send alert' }))

    await screen.findByRole('button', { name: 'Send alert' }) // settles back from "Sending…"

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('/api/fleet/truck_1/alert')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ message: 'Low fuel' })
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({ 'X-Dispatcher-Id': 'dispatcher_abc' })

    // Pessimistic UI: the textarea clears on success, but the alert itself
    // is not written directly by this widget — it appears once the
    // truck_alert echo lands (proven separately below).
    expect((screen.getByLabelText('Send alert') as HTMLTextAreaElement).value).toBe('')
  })

  it('FR-32: an alert already in the store (as the WS echo would land it) is visible to every dispatcher, sender included', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')
    store.getState().addTruckAlert(makeAlert({ message: 'Low fuel', dispatcherName: 'Alice' }))

    render(<VehicleDetail />)
    const history = screen.getByTestId('alert-history')
    expect(history.textContent).toContain('Low fuel')
    expect(history.textContent).toContain('Alice')
  })

  it('code-review regression: a second alert to an already-shown truck re-renders without unmounting — addTruckAlert must not reuse the same buffer reference', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')
    store.getState().addTruckAlert(makeAlert({ message: 'First alert', timestamp: 1_000 }))

    render(<VehicleDetail />)
    expect(screen.getByTestId('alert-history').textContent).toContain('First alert')

    // No unmount/remount in between — proves the subscribed component
    // itself re-renders off the new `state.fleet.alerts[truckId]` reference,
    // not just that a fresh render call happens to pick up fresh data.
    store.getState().addTruckAlert(makeAlert({ message: 'Second alert', timestamp: 2_000 }))

    expect(await screen.findByText('Second alert')).toBeTruthy()
    expect(screen.getByTestId('alert-history').textContent).toContain('First alert')
  })

  it('FR-32: multiple alerts for the same truck render newest-first', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')
    store.getState().addTruckAlert(makeAlert({ message: 'Oldest', timestamp: 1_000 }))
    store.getState().addTruckAlert(makeAlert({ message: 'Middle', timestamp: 2_000 }))
    store.getState().addTruckAlert(makeAlert({ message: 'Newest', timestamp: 3_000 }))

    render(<VehicleDetail />)
    const rows = screen.getByTestId('alert-history').querySelectorAll('li')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('Newest')
    expect(rows[1]!.textContent).toContain('Middle')
    expect(rows[2]!.textContent).toContain('Oldest')
  })

  it('shows a clear empty state with no alerts sent this session', async () => {
    const { store, VehicleDetail } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    expect(screen.getByText('No alerts sent this session')).toBeTruthy()
  })

  it('a non-conflict failure surfaces a visible inline error, never a modal (CM2)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(500, { error: 'boom', message: 'server exploded' }))
    const { store, VehicleDetail } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    fireEvent.change(screen.getByLabelText('Send alert'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send alert' }))

    expect((await screen.findByRole('alert')).textContent).toContain('server exploded')
  })

  it('FR-16: refused locally with a visible reason while unregistered — no request sent', async () => {
    const fetchImpl = vi.fn()
    const { store, VehicleDetail } = await freshHarness({ fetchImpl, dispatcherId: null })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().selectTruck('truck_1')

    render(<VehicleDetail />)
    fireEvent.change(screen.getByLabelText('Send alert'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send alert' }))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('VehicleDetail — registration (AD-6, FR-28)', () => {
  it('registers itself under id "vehicle-detail"', async () => {
    vi.resetModules()
    const { getWidgets } = await import('../../registry.ts')
    await import('./VehicleDetail.tsx')
    expect(getWidgets().some((widget) => widget.id === 'vehicle-detail')).toBe(true)
  })
})
