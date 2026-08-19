// @vitest-environment jsdom
// FleetPulse — FleetOverview widget tests (FR-1, FR-2, FR-3, FR-4)
//
// This widget subscribes to the *production* store singleton
// (`getFleetPulseStore()`, store.ts — AD-1: `ui/` reaches the store only
// via `store/`, never a prop-drilled instance), so isolating one test from
// the next means isolating the module graph, not just calling a reset
// action: each test resets Vitest's module registry and re-imports fresh.
//
// The FR-3 case only proves the *widget's* rendering (one marker, snapped
// to whatever the store's `latest` envelope says, plus one sorted trail
// polyline over `history`) — that the pipeline itself produces a
// newest-by-timestamp `latest` from a non-monotonic batch is already
// covered by `pipeline/index.test.ts`'s own mandated FR-6/NFR-2 case; `ui/`
// never imports `pipeline/` (AD-1), so this test drives the store directly
// via `applyTelemetryCommits`, the same seam `store/slices/telemetrySlice.test.ts`
// uses.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Truck } from '../../../contract/rest.ts'
import type { PipelineCommit } from '../../../pipeline/index.ts'
import { CLIENT_THRESHOLDS } from '../../../../shared/constants.js'

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
  const { FleetOverview } = await import('./FleetOverview.tsx')
  return { store: getFleetPulseStore(), FleetOverview }
}

afterEach(() => {
  cleanup()
})

describe('FleetOverview', () => {
  it('I/O matrix: app mounts before getFleet() resolves -> loading state, no crash', async () => {
    const { FleetOverview } = await freshHarness()
    render(<FleetOverview />)
    expect(screen.getByText('Loading fleet…')).toBeTruthy()
  })

  it('I/O matrix: getFleet() exhausted its retry/breaker budget -> inline "fleet unavailable" state, never a modal (CM2)', async () => {
    const { store, FleetOverview } = await freshHarness()
    store.getState().setFleetFetchFailed()
    render(<FleetOverview />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('unavailable')
  })

  it('FR-1/FR-2: all 12 trucks render once GET /api/fleet resolves, with status visually distinct via data-status', async () => {
    const { store, FleetOverview } = await freshHarness()
    const statuses: Truck['status'][] = ['active', 'idle', 'maintenance']
    const trucks = Array.from({ length: 12 }, (_, i) => makeTruck({ truckId: `truck_${i + 1}`, status: statuses[i % 3] }))
    store.getState().setFleet(trucks)

    const { container } = render(<FleetOverview />)

    for (const truck of trucks) {
      expect(screen.getByText(truck.truckId)).toBeTruthy() // roster only — no telemetry yet, so no SVG marker duplicate
    }
    for (const status of statuses) {
      expect(container.querySelectorAll(`[data-status="${status}"]`).length).toBeGreaterThan(0)
    }
  })

  it('FR-3 (mandated): a non-monotonic GPS batch snaps the marker to the newest-by-timestamp position and draws one sorted trail — never separate markers', async () => {
    const { store, FleetOverview } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])

    const size = 30
    const readings = Array.from({ length: size }, (_, i) => ({
      value: { lat: 32 + i * 0.01, lng: 34 + i * 0.01 },
      trust: 'trusted' as const,
      readingTs: i * 1_000,
      arrivalTs: 0,
    }))
    const newest = readings[size - 1]!
    // Non-monotonic on arrival — one interior swap, mirroring server.js's
    // own occasional out-of-order entry — proving the widget doesn't rely
    // on array order, only on the store's already-sorted history.
    const shuffled = [readings[10]!, ...readings.slice(0, 10), ...readings.slice(11)]
    expect(shuffled).toHaveLength(size)

    const commit: PipelineCommit = {
      truckId: 'truck_1',
      signals: [{ signal: 'position', live: newest, historyEntries: shuffled }],
    }
    store.getState().applyTelemetryCommits([commit])

    const { container } = render(<FleetOverview />)

    const markers = container.querySelectorAll('[data-testid="marker-truck_1"] circle')
    expect(markers).toHaveLength(1) // exactly one marker — never one per batch reading

    const trail = container.querySelector('[data-testid="trail-truck_1"]')
    expect(trail).not.toBeNull()
    const points = trail!.getAttribute('points')!.trim().split(' ')
    expect(points).toHaveLength(size) // the full batch enters the trail

    // The marker sits exactly at the newest point's projected position —
    // the last point of the (store-sorted) trail.
    const marker = markers[0]!
    const lastTrailPoint = points[points.length - 1]!
    expect(`${marker.getAttribute('cx')},${marker.getAttribute('cy')}`).toBe(lastTrailPoint)
  })

  it('FR-4: a truck past STALENESS_BADGE_THRESHOLD_MS since arrival shows the stale badge; staleness is the arrival clock only', async () => {
    const { store, FleetOverview } = await freshHarness()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    // health.nowMs defaults to the real Date.now() at store creation —
    // align it to 0 first so a reading with arrivalTs: 0 reads as "just
    // arrived," not as instantly decades stale (same setup as
    // selectors/effectiveTrust.test.ts).
    store.getState().tickStaleness(0)
    store.getState().applyTelemetryCommits([
      {
        truckId: 'truck_1',
        signals: [
          {
            signal: 'position',
            // readingTs 0 but arrivalTs also 0 — the point under test is
            // the *tick*, driven off arrivalTs, not the reading's own age.
            live: { value: { lat: 32, lng: 34 }, trust: 'trusted', readingTs: 0, arrivalTs: 0 },
            historyEntries: [],
          },
        ],
      },
    ])

    const { rerender } = render(<FleetOverview />)
    expect(screen.queryByText('Stale')).toBeNull() // fresh contact just now

    store.getState().tickStaleness(CLIENT_THRESHOLDS.STALENESS_BADGE_THRESHOLD_MS + 1)
    rerender(<FleetOverview />)
    expect(screen.getByText('Stale')).toBeTruthy()
  })
})
