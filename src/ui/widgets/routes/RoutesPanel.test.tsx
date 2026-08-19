// @vitest-environment jsdom
// FleetPulse — RoutesPanel widget tests (FR-10..15, FR-34, AD-16, AD-7)
//
// Same isolation convention as PresencePanel.test.tsx: this widget
// subscribes to the *production* store singleton and constructs its own
// module-scope `routesApiClient` at import time (reading the stubbed global
// `fetch` current at that moment) — isolating one test from the next means
// resetting Vitest's module registry and re-importing fresh, stubbing
// `fetch`/the WS send facade *before* that import.
//
// Route rows and audit rows are looked up by `data-testid` (not raw text),
// since the audit trail deliberately reuses the same raw strings
// (`truckId`, `status`/`eventType`) the route row itself renders — a plain
// `getByText` would be ambiguous between the two.
//
// Pessimistic UI throughout: a mutation's mocked 2xx never writes route
// data directly — every "does it appear" assertion goes through an
// explicit `store.getState().applyRouteAssigned(...)`-style echo (or a real
// WS-shaped commit) plus a rerender, exactly like the AD-16 contract
// promises.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ConflictErrorBody, Route, Truck } from '../../../contract/rest.ts'

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

function makeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response
}

function makeConflictBody(overrides: Partial<ConflictErrorBody> = {}): ConflictErrorBody {
  return {
    error: 'version_conflict',
    message: 'stale',
    conflictingDispatcher: { dispatcherId: 'dispatcher_system', name: 'System' },
    currentRoute: makeRoute({ version: 5 }),
    ...overrides,
  }
}

async function freshHarness(options: { fetchImpl?: ReturnType<typeof vi.fn>; dispatcherId?: string | null } = {}) {
  vi.resetModules()
  if (options.fetchImpl) vi.stubGlobal('fetch', options.fetchImpl)
  const { getFleetPulseStore } = await import('../../../store/store.ts')
  const { setWsSendFacade } = await import('../../../transport/ws-manager.ts')
  const dispatcherId = 'dispatcherId' in options ? options.dispatcherId! : 'dispatcher_abc'
  const register = vi.fn()
  const sendViewing = vi.fn()
  setWsSendFacade({ register, sendViewing, getDispatcherId: () => dispatcherId })
  const { RoutesPanel } = await import('./RoutesPanel.tsx')
  return { store: getFleetPulseStore(), RoutesPanel }
}

afterEach(() => {
  cleanup()
})

describe('RoutesPanel — create route (FR-10, FR-34)', () => {
  it('renders empty-state headings before any route or truck data exists', async () => {
    const { RoutesPanel } = await freshHarness()
    render(<RoutesPanel />)
    expect(screen.getByRole('heading', { name: 'Create route' })).toBeTruthy()
    expect(screen.getByText('No routes yet')).toBeTruthy()
    expect(screen.getByText('No route activity yet this session')).toBeTruthy()
  })

  it('idle truck, no active route: submits createRoute on the first click, no warning shown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(201, makeRoute()))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', status: 'idle' })])

    render(<RoutesPanel />)
    fireEvent.change(screen.getByLabelText('Truck'), { target: { value: 'truck_1' } })
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'Warehouse A' } })
    expect(screen.queryByRole('alert')).toBeNull() // no warning for an idle, routeless truck

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }))
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/routes')
    expect((init as RequestInit).method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Dispatcher-Id']).toBe('dispatcher_abc')

    // Pessimistic UI: no direct write from the 2xx — still "No routes yet"
    // until the matching route_assigned echo lands.
    expect(screen.getByText('No routes yet')).toBeTruthy()
  })

  it('FR-34: truck already has an active route -> warn-and-confirm; first click only arms, second click submits', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(201, makeRoute({ routeId: 'route_2' })))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', status: 'active' })])
    store.getState().applyRouteAssigned(makeRoute({ routeId: 'route_1', truckId: 'truck_1', status: 'assigned' }))

    render(<RoutesPanel />)
    fireEvent.change(screen.getByLabelText('Truck'), { target: { value: 'truck_1' } })
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'Depot B' } })

    expect(screen.getByRole('alert').textContent).toContain('already has an active route')
    expect(screen.getByRole('alert').textContent).toContain('Bob')

    fireEvent.click(screen.getByRole('button', { name: 'Create route' }))
    expect(fetchImpl).not.toHaveBeenCalled() // armed only, not submitted

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm create' }))
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('FR-34: a truck in maintenance also triggers warn-and-confirm', async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', status: 'maintenance' })])

    render(<RoutesPanel />)
    fireEvent.change(screen.getByLabelText('Truck'), { target: { value: 'truck_1' } })
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'Depot B' } })

    expect(screen.getByRole('alert').textContent).toContain('maintenance')
  })

  it('validates required fields before submitting — no truck/destination means no request', async () => {
    const fetchImpl = vi.fn()
    const { RoutesPanel } = await freshHarness({ fetchImpl })
    render(<RoutesPanel />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }))
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Choose a truck')
  })

  it('FR-16: mutating while unregistered (no dispatcherId) is refused locally by api-client — visible error, no request sent', async () => {
    const fetchImpl = vi.fn()
    const { store, RoutesPanel } = await freshHarness({ fetchImpl, dispatcherId: null })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', status: 'idle' })])

    render(<RoutesPanel />)
    fireEvent.change(screen.getByLabelText('Truck'), { target: { value: 'truck_1' } })
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'Depot B' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }))
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('reconnect')
  })

  it('a 503 (retryable) failure surfaces its own visible message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 503,
      ok: false,
      headers: { get: (name: string) => (name === 'Retry-After' ? '4' : null) },
      json: async () => ({ error: 'fleet_unavailable', message: 'busy' }),
    } as unknown as Response)
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', status: 'idle' })])

    render(<RoutesPanel />)
    fireEvent.change(screen.getByLabelText('Truck'), { target: { value: 'truck_1' } })
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'Depot B' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }))
    })

    expect(screen.getByRole('alert').textContent).toContain('4s')
  })
})

describe('RoutesPanel — route list: legal transitions only (FR-11)', () => {
  it("offers only the transitions legal from the route's current status", async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned' }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    expect(within(row).getByRole('button', { name: 'Start (in progress)' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Confirm cancel' })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Complete' })).toBeNull()
  })

  it('a terminal route (completed) offers no transitions and no reassign control', async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' }), makeTruck({ truckId: 'truck_2' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'completed', version: 3 }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    expect(within(row).queryByRole('button')).toBeNull()
    expect(within(row).queryByLabelText(/Reassign/)).toBeNull()
  })

  it('defensive fallback: an unrecognized route.status never throws and offers no transitions', async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'blocked' as Route['status'] }))

    expect(() => render(<RoutesPanel />)).not.toThrow()
    const row = screen.getByTestId('route-row-route_1')
    expect(within(row).queryByRole('button')).toBeNull()
  })
})

describe('RoutesPanel — cancel and reassign require confirmation (FR-14, NFR-6)', () => {
  it('cancel: first click arms, second click submits updateRouteStatus({status:"cancelled"})', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, makeRoute({ status: 'cancelled', version: 2 })))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    const cancelButton = within(row).getByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelButton)
    expect(fetchImpl).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel' }))
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/routes/route_1')
    expect((init as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: 'cancelled' })
    expect((init.headers as Record<string, string>)['If-Match']).toBe('1')
  })

  it('reassign: first click arms, second click submits, and a successful reassign resets the target select (review finding, iteration 1)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, makeRoute({ truckId: 'truck_2', version: 2 })))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' }), makeTruck({ truckId: 'truck_2' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1, truckId: 'truck_1' }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    const reassignSelect = within(row).getByLabelText('Reassign route_1 to') as HTMLSelectElement
    fireEvent.change(reassignSelect, { target: { value: 'truck_2' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Reassign' }))
    expect(fetchImpl).not.toHaveBeenCalled() // armed only

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm reassign' }))
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/routes/route_1/reassign')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ truckId: 'truck_2' })

    // Reset: the select goes back to its placeholder, so a stale target
    // can't silently resubmit a same-truck reassign next time.
    expect((within(row).getByLabelText('Reassign route_1 to') as HTMLSelectElement).value).toBe('')
  })

  it('FR-13: a 409 on cancel renders the shared ConflictChooser naming the conflicting dispatcher and both versions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, makeConflictBody()))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel' }))
    })

    const chooser = within(row).getByTestId('conflict-chooser')
    expect(chooser.textContent).toContain('System') // conflictingDispatcher.name
    expect(chooser.textContent).toContain('version 5') // currentRoute.version
    expect(chooser.textContent).toContain('Cancel') // myIntentLabel
    // The plain "reload and retry" error text is gone — the chooser replaced it.
    expect(within(row).queryByText(/Reload and retry/i)).toBeNull()
  })
})

describe('RoutesPanel — FR-13: transition/cancel and reassign reach the exact same ConflictChooser', () => {
  it('a 409 on a non-destructive transition (no arm step, e.g. "Start (in progress)") also renders the shared ConflictChooser', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, makeConflictBody()))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Start (in progress)' }))
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const chooser = within(row).getByTestId('conflict-chooser')
    expect(chooser.textContent).toContain('System')
    expect(chooser.textContent).toContain('Start (in progress)') // myIntentLabel
  })

  it('a 409 on reassign renders the same shared ConflictChooser component transition/cancel uses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, makeConflictBody()))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' }), makeTruck({ truckId: 'truck_2' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1, truckId: 'truck_1' }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    const reassignSelect = within(row).getByLabelText('Reassign route_1 to')
    fireEvent.change(reassignSelect, { target: { value: 'truck_2' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Reassign' }))
    expect(fetchImpl).not.toHaveBeenCalled() // armed only

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm reassign' }))
    })

    const chooser = within(row).getByTestId('conflict-chooser')
    expect(chooser.textContent).toContain('System')
    expect(chooser.textContent).toContain('version 5')
    expect(chooser.textContent).toContain('Reassign to truck_2') // myIntentLabel
  })

  it('Adopt clears the armed/failure state and sends no further request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, makeConflictBody()))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel' }))
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    fireEvent.click(within(row).getByRole('button', { name: 'Use their version' }))

    expect(within(row).queryByTestId('conflict-chooser')).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1) // Adopt sends no request
    // Back to the row's normal controls, ready to arm again.
    expect(within(row).getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('Back out clears the armed/failure state and sends no further request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, makeConflictBody()))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel' }))
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    fireEvent.click(within(row).getByRole('button', { name: 'Never mind' }))

    expect(within(row).queryByTestId('conflict-chooser')).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1) // Back out sends no request
  })

  it("Re-apply resubmits the same intended mutation with If-Match set to the failure body's currentRoute.version", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(409, makeConflictBody({ currentRoute: makeRoute({ version: 7 }) })))
      .mockResolvedValueOnce(makeResponse(200, makeRoute({ status: 'cancelled', version: 8 })))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel' }))
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // First attempt used the version known at arm-time (1).
    const [, firstInit] = fetchImpl.mock.calls[0]!
    expect((firstInit.headers as Record<string, string>)['If-Match']).toBe('1')

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Re-apply' }))
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[1]!
    expect(url).toBe('/api/routes/route_1')
    expect((init as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: 'cancelled' })
    expect((init.headers as Record<string, string>)['If-Match']).toBe('7') // the 409 body's currentRoute.version
    expect(within(row).queryByTestId('conflict-chooser')).toBeNull()
  })

  it('a repeated conflict on Re-apply replaces the chooser with the newer failure body instead of erroring out', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(409, makeConflictBody({ currentRoute: makeRoute({ version: 7 }) })))
      .mockResolvedValueOnce(
        makeResponse(
          409,
          makeConflictBody({
            conflictingDispatcher: { dispatcherId: 'dispatcher_other', name: 'Ada' },
            currentRoute: makeRoute({ version: 9 }),
          }),
        ),
      )
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel' }))
    })
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Re-apply' }))
    })

    const chooser = within(row).getByTestId('conflict-chooser')
    expect(chooser.textContent).toContain('Ada')
    expect(chooser.textContent).toContain('version 9')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("Re-apply after a reassign-triggered conflict resubmits reassignRoute with the target truckId and If-Match set to the failure body's currentRoute.version", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(409, makeConflictBody({ currentRoute: makeRoute({ version: 6 }) })))
      .mockResolvedValueOnce(makeResponse(200, makeRoute({ truckId: 'truck_2', version: 7 })))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' }), makeTruck({ truckId: 'truck_2' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1, truckId: 'truck_1' }))

    render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    const reassignSelect = within(row).getByLabelText('Reassign route_1 to')
    fireEvent.change(reassignSelect, { target: { value: 'truck_2' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Reassign' }))
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm reassign' }))
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Re-apply' }))
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[1]!
    expect(url).toBe('/api/routes/route_1/reassign')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ truckId: 'truck_2' })
    expect((init.headers as Record<string, string>)['If-Match']).toBe('6') // the 409 body's currentRoute.version
    expect(within(row).queryByTestId('conflict-chooser')).toBeNull()
  })
})

describe('RoutesPanel — FR-31 avoidance notice (fires while armed, silent while unarmed)', () => {
  it('shows a non-blocking notice naming the other dispatcher when the live version moves while cancel is armed, and the confirm control stays enabled', async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    const { rerender } = render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))

    expect(within(row).queryByTestId('avoidance-notice-route_1')).toBeNull()

    // Another dispatcher's change lands via WS echo before we confirm.
    store
      .getState()
      .applyRouteUpdated(makeRoute({ status: 'assigned', version: 2, updatedBy: { dispatcherId: 'dispatcher_other', name: 'Ada' } }))
    rerender(<RoutesPanel />)

    const notice = within(row).getByTestId('avoidance-notice-route_1')
    expect(notice.textContent).toContain('Ada')
    expect(notice.textContent).toMatch(/version/i)

    const confirmButton = within(row).getByRole('button', { name: 'Confirm cancel' }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(false) // non-blocking: still submittable
  })

  it('shows the same non-blocking notice when the live version moves while reassign (not cancel) is armed', async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' }), makeTruck({ truckId: 'truck_2' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1, truckId: 'truck_1' }))

    const { rerender } = render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    const reassignSelect = within(row).getByLabelText('Reassign route_1 to')
    fireEvent.change(reassignSelect, { target: { value: 'truck_2' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Reassign' }))

    expect(within(row).queryByTestId('avoidance-notice-route_1')).toBeNull()

    // Another dispatcher's change lands via WS echo before we confirm.
    store.getState().applyRouteUpdated(
      makeRoute({ status: 'assigned', version: 2, truckId: 'truck_1', updatedBy: { dispatcherId: 'dispatcher_other', name: 'Ada' } }),
    )
    rerender(<RoutesPanel />)

    const notice = within(row).getByTestId('avoidance-notice-route_1')
    expect(notice.textContent).toContain('Ada')
    expect(notice.textContent).toMatch(/version/i)

    const confirmButton = within(row).getByRole('button', { name: 'Confirm reassign' }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(false) // non-blocking: still submittable
  })

  it('shows no notice when the version moves while the row has no armed action', async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    const { rerender } = render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')

    store
      .getState()
      .applyRouteUpdated(makeRoute({ status: 'assigned', version: 2, updatedBy: { dispatcherId: 'dispatcher_other', name: 'Ada' } }))
    rerender(<RoutesPanel />)

    expect(within(row).queryByTestId('avoidance-notice-route_1')).toBeNull()
  })

  it('proceeding after the notice can still land in the ConflictChooser if the submit itself then 409s', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, makeConflictBody({ currentRoute: makeRoute({ version: 2 }) })))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ status: 'assigned', version: 1 }))

    const { rerender } = render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))

    store
      .getState()
      .applyRouteUpdated(makeRoute({ status: 'assigned', version: 2, updatedBy: { dispatcherId: 'dispatcher_other', name: 'Ada' } }))
    rerender(<RoutesPanel />)
    expect(within(row).getByTestId('avoidance-notice-route_1')).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm cancel' }))
    })

    expect(within(row).getByTestId('conflict-chooser')).toBeTruthy()
  })
})

describe('RoutesPanel — create never conflicts (FR-10, FR-34 out of scope for FR-13)', () => {
  it("createRoute's error path is unchanged — describeFailure's plain text renders, the ConflictChooser never appears for create", async () => {
    // createRoute has no If-Match and cannot conflict server-side (Boundaries
    // & Constraints) — but api-client's mutate() normalizes any 409 the same
    // way regardless of endpoint, so this proves CreateRouteForm's own error
    // path (plain describeFailure text) is untouched even in that
    // hypothetical, and the chooser is never wired into create's call site.
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, makeConflictBody({ currentRoute: makeRoute({ version: 9 }) })))
    const { store, RoutesPanel } = await freshHarness({ fetchImpl })
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', status: 'idle' })])

    render(<RoutesPanel />)
    fireEvent.change(screen.getByLabelText('Truck'), { target: { value: 'truck_1' } })
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'Depot B' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }))
    })

    expect(screen.queryByTestId('conflict-chooser')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('System')
    expect(screen.getByRole('alert').textContent).toContain('Reload and retry')
  })
})

describe('RoutesPanel — AD-16: routes and the audit trail only reflect committed echoes', () => {
  it('a route appears in the list and the audit trail only after applyRouteAssigned commits (not on the mocked HTTP 2xx alone)', async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])

    const { rerender } = render(<RoutesPanel />)
    expect(screen.getByText('No routes yet')).toBeTruthy()

    store.getState().applyRouteAssigned(makeRoute())
    rerender(<RoutesPanel />)

    const row = screen.getByTestId('route-row-route_1')
    expect(within(row).getByText('truck_1')).toBeTruthy()
    expect(within(row).getByText('Warehouse A')).toBeTruthy()
    expect(within(row).getByText('assigned')).toBeTruthy()

    const auditRow = screen.getByTestId('audit-row-route_1-1')
    expect(within(auditRow).getByText('assigned')).toBeTruthy() // eventType
    expect(within(auditRow).getByText('truck_1')).toBeTruthy()
    expect(within(auditRow).getByText(/by Bob/)).toBeTruthy()
  })

  it('AD-16 (mandated): a stale echo (version <= stored) never changes what the widget renders', async () => {
    const { store, RoutesPanel } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().applyRouteAssigned(makeRoute({ version: 3, status: 'in-progress' }))

    const { rerender } = render(<RoutesPanel />)
    const row = screen.getByTestId('route-row-route_1')
    expect(within(row).getByText('in-progress')).toBeTruthy()

    store.getState().applyRouteUpdated(makeRoute({ version: 2, status: 'cancelled' }))
    rerender(<RoutesPanel />)

    expect(within(row).getByText('in-progress')).toBeTruthy()
    expect(within(row).queryByText('cancelled')).toBeNull()
    // No second audit row for the dropped echo either.
    expect(screen.queryAllByTestId(/audit-row-/)).toHaveLength(1)
  })
})
