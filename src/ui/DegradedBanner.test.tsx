// @vitest-environment jsdom
// FleetPulse — DegradedBanner tests (FR-26, AD-9, CM2)
//
// Same fresh-module-graph convention as FleetOverview.test.tsx: this
// component subscribes to the production store singleton
// (`getFleetPulseStore()`), so isolating one test from the next means
// isolating the module graph.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

async function freshHarness() {
  vi.resetModules()
  const { getFleetPulseStore } = await import('../store/store.ts')
  const { DegradedBanner } = await import('./DegradedBanner.tsx')
  return { store: getFleetPulseStore(), DegradedBanner }
}

afterEach(() => {
  cleanup()
})

describe('DegradedBanner', () => {
  it('renders nothing while both conditions are healthy', async () => {
    const { DegradedBanner } = await freshHarness()
    const { container } = render(<DegradedBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('FR-26: names "telemetry stream down" when that condition alone is set', async () => {
    const { store, DegradedBanner } = await freshHarness()
    store.getState().setTelemetryStreamDown(true, 0)
    render(<DegradedBanner />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('telemetry stream down')
    expect(alert.textContent).not.toContain('fleet fetches failing')
  })

  it('FR-25/FR-26: names "fleet fetches failing" when that condition alone is set', async () => {
    const { store, DegradedBanner } = await freshHarness()
    store.getState().setFleetFetchFailing(true, 0)
    render(<DegradedBanner />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('fleet fetches failing')
    expect(alert.textContent).not.toContain('telemetry stream down')
  })

  it('names both conditions together — a legal, labeled combined state', async () => {
    const { store, DegradedBanner } = await freshHarness()
    store.getState().setTelemetryStreamDown(true, 0)
    store.getState().setFleetFetchFailing(true, 0)
    render(<DegradedBanner />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('telemetry stream down')
    expect(alert.textContent).toContain('fleet fetches failing')
  })

  it('CM2: stays visible until the hysteresis-gated clear actually flips the condition, never a flap on a bare recovery report', async () => {
    const { store, DegradedBanner } = await freshHarness()
    store.getState().setTelemetryStreamDown(true, 0)
    store.getState().setTelemetryStreamDown(false, 1_000) // recovered, but hysteresis pending
    const { rerender } = render(<DegradedBanner />)
    expect(screen.getByRole('alert')).toBeTruthy()

    store.getState().tickStaleness(6_000) // past BANNER_CLEAR_HYSTERESIS_MS
    rerender(<DegradedBanner />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
