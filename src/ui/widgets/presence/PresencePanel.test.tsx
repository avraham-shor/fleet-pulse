// @vitest-environment jsdom
// FleetPulse — PresencePanel widget tests (FR-16, FR-17, FR-18, FR-19, AD-17)
//
// Same isolation convention as FleetOverview.test.tsx: this widget
// subscribes to the *production* store singleton (`getFleetPulseStore()`),
// so isolating one test from the next means resetting Vitest's module
// registry and re-importing fresh, not just calling a reset action.
// `getWsSendFacade`'s singleton (ws-manager.ts) needs the same treatment —
// each test wires a fresh fake facade before rendering.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Truck } from '../../../contract/rest.ts'

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

async function freshHarness() {
  vi.resetModules()
  const { getFleetPulseStore } = await import('../../../store/store.ts')
  const { setWsSendFacade } = await import('../../../transport/ws-manager.ts')
  const { PresencePanel } = await import('./PresencePanel.tsx')
  const register = vi.fn()
  const sendViewing = vi.fn()
  setWsSendFacade({ register, sendViewing })
  return { store: getFleetPulseStore(), PresencePanel, register, sendViewing }
}

afterEach(() => {
  cleanup()
})

describe('PresencePanel', () => {
  it('FR-17: renders "no other dispatchers" before anyone joins', async () => {
    const { PresencePanel } = await freshHarness()
    render(<PresencePanel />)
    expect(screen.getByText('No other dispatchers active')).toBeTruthy()
    expect(screen.getByText('Not registered yet')).toBeTruthy()
  })

  it('FR-16: submitting the name form calls the send facade\'s register() and shows optimistic "You: X" local state — never written to the presence slice (AD-17)', async () => {
    const { store, PresencePanel, register } = await freshHarness()
    render(<PresencePanel />)

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Alice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))

    expect(register).toHaveBeenCalledWith('Alice')
    expect(screen.getByText('Alice')).toBeTruthy() // "You: Alice"
    expect(store.getState().presence.dispatchers).toEqual({}) // own identity never enters presence
  })

  it('ignores an empty/whitespace-only name submit — no send, no optimistic state change', async () => {
    const { PresencePanel, register } = await freshHarness()
    render(<PresencePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Register' })) // empty input
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' })) // whitespace-only

    expect(register).not.toHaveBeenCalled()
    expect(screen.getByText('Not registered yet')).toBeTruthy()
  })

  it('FR-17/FR-19 (mandated): two dispatchers sharing a name both render as distinct rows, keyed by dispatcherId', async () => {
    const { store, PresencePanel } = await freshHarness()
    store.getState().dispatcherJoined('dispatcher_1', 'Dana', 0)
    store.getState().dispatcherJoined('dispatcher_2', 'Dana', 0)

    render(<PresencePanel />)
    expect(screen.getAllByText('Dana')).toHaveLength(2)
  })

  it('FR-19 (mandated): a live dispatcher_left removes that dispatcher\'s already-rendered row from the DOM, leaving the other one', async () => {
    const { store, PresencePanel } = await freshHarness()
    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 0)
    store.getState().dispatcherJoined('dispatcher_2', 'Bob', 0)

    const { rerender } = render(<PresencePanel />)
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()

    store.getState().dispatcherLeft('dispatcher_1')
    // A direct store mutation outside fireEvent/a user event needs an
    // explicit rerender to observe the fresh snapshot — same convention as
    // FleetOverview.test.tsx's own staleness-badge test.
    rerender(<PresencePanel />)

    expect(screen.queryByText('Alice')).toBeNull()
    expect(screen.getByText('Bob')).toBeTruthy()
  })

  it('FR-18: shows each other dispatcher\'s currently viewed truck, or "Not viewing a truck" when null', async () => {
    const { store, PresencePanel } = await freshHarness()
    store.getState().dispatcherJoined('dispatcher_1', 'Alice', 0)
    store.getState().applyDispatcherViewing('dispatcher_1', 'truck_3', 10)
    store.getState().dispatcherJoined('dispatcher_2', 'Bob', 0)

    render(<PresencePanel />)
    expect(screen.getByText('Viewing truck_3')).toBeTruthy()
    expect(screen.getByText('Not viewing a truck')).toBeTruthy()
  })

  it('FR-18: picking a truck in the viewing selector sends sendViewing(truckId); picking "None" sends the explicit clear sendViewing(null)', async () => {
    const { store, PresencePanel, sendViewing } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' }), makeTruck({ truckId: 'truck_2' })])

    render(<PresencePanel />)
    const select = screen.getByLabelText('Viewing') as HTMLSelectElement

    fireEvent.change(select, { target: { value: 'truck_2' } })
    expect(sendViewing).toHaveBeenCalledWith('truck_2')

    fireEvent.change(select, { target: { value: '' } }) // "None"
    expect(sendViewing).toHaveBeenLastCalledWith(null)
  })

  it('never crashes when the send facade has not been wired yet (a widget rendering before bootstrap runs)', async () => {
    vi.resetModules()
    const { resetWsSendFacadeForTests } = await import('../../../transport/ws-manager.ts')
    resetWsSendFacadeForTests()
    const { PresencePanel } = await import('./PresencePanel.tsx')

    render(<PresencePanel />)
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Alice' } })
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Register' }))).not.toThrow()
    // Still optimistic even with nothing wired to actually send it.
    expect(screen.getByText('Alice')).toBeTruthy()
  })
})
