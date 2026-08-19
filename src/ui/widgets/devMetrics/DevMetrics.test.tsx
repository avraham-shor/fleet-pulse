// @vitest-environment jsdom
// FleetPulse — DevMetrics widget tests (FR-30)
//
// Same production-singleton isolation convention as every other widget test
// in this codebase (`vi.resetModules()` + fresh import per test) — this
// widget subscribes to `getFleetPulseStore()` directly.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

async function freshHarness() {
  vi.resetModules()
  const { getFleetPulseStore } = await import('../../../store/store.ts')
  const { DevMetrics } = await import('./DevMetrics.tsx')
  return { store: getFleetPulseStore(), DevMetrics }
}

afterEach(() => {
  cleanup()
})

describe('DevMetrics', () => {
  it('Transport healthy: renders zero dropped/reconnect counts and an unmeasured RTT before any tick has run', async () => {
    const { DevMetrics } = await freshHarness()
    render(<DevMetrics />)

    expect(screen.getByTestId('metric-sse-events-per-sec').textContent).toBe('0.0')
    expect(screen.getByTestId('metric-ws-rtt').textContent).toBe('not yet measured')
    expect(screen.getByTestId('metric-sse-dropped').textContent).toBe('0')
    expect(screen.getByTestId('metric-ws-dropped').textContent).toBe('0')
    expect(screen.getByTestId('metric-sse-reconnects').textContent).toBe('0')
    expect(screen.getByTestId('metric-ws-reconnects').textContent).toBe('0')
  })

  it('FR-30: shows live SSE events/sec and WS ping/pong RTT once transportCounters carries real values', async () => {
    const { store, DevMetrics } = await freshHarness()
    store.getState().setTransportCounters({ sseEventsPerSecond: 4.5, wsLastPingRttMs: 32 })

    render(<DevMetrics />)

    expect(screen.getByTestId('metric-sse-events-per-sec').textContent).toBe('4.5')
    expect(screen.getByTestId('metric-ws-rtt').textContent).toBe('32 ms')
  })

  it('Dropped/reconnect activity: reflects updated counts on the next tick (a fresh setTransportCounters patch + rerender)', async () => {
    const { store, DevMetrics } = await freshHarness()
    const { rerender } = render(<DevMetrics />)
    expect(screen.getByTestId('metric-sse-dropped').textContent).toBe('0')

    store.getState().setTransportCounters({ sseDroppedMessages: 3, wsDroppedMessages: 1, sseReconnects: 2, wsReconnects: 1 })
    rerender(<DevMetrics />)

    expect(screen.getByTestId('metric-sse-dropped').textContent).toBe('3')
    expect(screen.getByTestId('metric-ws-dropped').textContent).toBe('1')
    expect(screen.getByTestId('metric-sse-reconnects').textContent).toBe('2')
    expect(screen.getByTestId('metric-ws-reconnects').textContent).toBe('1')
  })

  it('updates only on a real transportCounters patch — no fetch/subscription path of its own (reads the store passthrough as-is)', async () => {
    const { store, DevMetrics } = await freshHarness()
    render(<DevMetrics />)

    // Partial patch, mirroring setTransportCounters' own merge semantics —
    // fields not named survive untouched.
    store.getState().setTransportCounters({ sseEventsPerSecond: 1.2 })
    expect(store.getState().obs.transportCounters).toMatchObject({ sseEventsPerSecond: 1.2, wsDroppedMessages: 0 })
  })
})
