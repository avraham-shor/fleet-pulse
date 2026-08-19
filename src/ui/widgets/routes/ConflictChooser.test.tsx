// @vitest-environment jsdom
// FleetPulse — ConflictChooser tests (FR-13)
//
// Testing Library's own queries + Vitest's built-in matchers only — no
// @testing-library/jest-dom (story boundary: no new dependency), mirroring
// TrustBadge.test.tsx's convention for a small, stateless, prop-driven
// display component. RoutesPanel.test.tsx covers the integration path
// (arm → 409 → chooser renders → Adopt/Re-apply/Back-out wiring); this file
// covers the component's own rendering and callback contract in isolation.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConflictChooser } from './ConflictChooser.tsx'
import type { Route, RouteActor } from '../../../contract/rest.ts'

afterEach(() => {
  cleanup()
})

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    routeId: 'route_1',
    truckId: 'truck_1',
    status: 'in-progress',
    version: 5,
    destination: 'Warehouse A',
    createdBy: { dispatcherId: 'dispatcher_other', name: 'Bob' },
    createdAt: 1_000,
    updatedAt: 2_000,
    updatedBy: { dispatcherId: 'dispatcher_other', name: 'Bob' },
    ...overrides,
  }
}

const conflictingDispatcher: RouteActor = { dispatcherId: 'dispatcher_system', name: 'System' }

describe('ConflictChooser (FR-13)', () => {
  it('names the conflicting dispatcher, both versions/status, and the intended change — side by side', () => {
    render(
      <ConflictChooser
        conflictingDispatcher={conflictingDispatcher}
        currentRoute={makeRoute()}
        myIntentLabel="Cancel"
        onAdopt={() => {}}
        onReapply={() => {}}
        onBackOut={() => {}}
      />,
    )

    const chooser = screen.getByTestId('conflict-chooser')
    expect(chooser.textContent).toContain('System')
    expect(chooser.textContent).toContain('version 5')
    expect(chooser.textContent).toContain('in-progress')
    expect(chooser.textContent).toContain('Cancel')
  })

  it('renders server-originated names as plain text, never interpreted (NFR-8)', () => {
    render(
      <ConflictChooser
        conflictingDispatcher={{ dispatcherId: 'dispatcher_x', name: '<script>alert(1)</script>' }}
        currentRoute={makeRoute()}
        myIntentLabel="Cancel"
        onAdopt={() => {}}
        onReapply={() => {}}
        onBackOut={() => {}}
      />,
    )

    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
  })

  it('Adopt ("Use their version") calls onAdopt and nothing else', () => {
    const onAdopt = vi.fn()
    const onReapply = vi.fn()
    const onBackOut = vi.fn()
    render(
      <ConflictChooser
        conflictingDispatcher={conflictingDispatcher}
        currentRoute={makeRoute()}
        myIntentLabel="Cancel"
        onAdopt={onAdopt}
        onReapply={onReapply}
        onBackOut={onBackOut}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use their version' }))

    expect(onAdopt).toHaveBeenCalledTimes(1)
    expect(onReapply).not.toHaveBeenCalled()
    expect(onBackOut).not.toHaveBeenCalled()
  })

  it('Re-apply calls onReapply and nothing else', () => {
    const onAdopt = vi.fn()
    const onReapply = vi.fn()
    const onBackOut = vi.fn()
    render(
      <ConflictChooser
        conflictingDispatcher={conflictingDispatcher}
        currentRoute={makeRoute()}
        myIntentLabel="Cancel"
        onAdopt={onAdopt}
        onReapply={onReapply}
        onBackOut={onBackOut}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Re-apply' }))

    expect(onReapply).toHaveBeenCalledTimes(1)
    expect(onAdopt).not.toHaveBeenCalled()
    expect(onBackOut).not.toHaveBeenCalled()
  })

  it('Back out ("Never mind") calls onBackOut and nothing else', () => {
    const onAdopt = vi.fn()
    const onReapply = vi.fn()
    const onBackOut = vi.fn()
    render(
      <ConflictChooser
        conflictingDispatcher={conflictingDispatcher}
        currentRoute={makeRoute()}
        myIntentLabel="Cancel"
        onAdopt={onAdopt}
        onReapply={onReapply}
        onBackOut={onBackOut}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Never mind' }))

    expect(onBackOut).toHaveBeenCalledTimes(1)
    expect(onAdopt).not.toHaveBeenCalled()
    expect(onReapply).not.toHaveBeenCalled()
  })

  it('reassign intent label renders identically to a transition intent label — one shared component, no branching per caller', () => {
    render(
      <ConflictChooser
        conflictingDispatcher={conflictingDispatcher}
        currentRoute={makeRoute()}
        myIntentLabel="Reassign to truck_2"
        onAdopt={() => {}}
        onReapply={() => {}}
        onBackOut={() => {}}
      />,
    )

    expect(screen.getByTestId('conflict-chooser').textContent).toContain('Reassign to truck_2')
  })
})
