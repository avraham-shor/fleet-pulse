// @vitest-environment jsdom
// FleetPulse — AnomalyView widget tests (FR-29, AD-18)
//
// Same isolation convention as every other widget test in this codebase:
// this widget subscribes to the *production* store singleton
// (`getFleetPulseStore()`), so isolating one test from the next means
// resetting Vitest's module registry and re-importing fresh, not just
// calling a reset action (mirrors PresencePanel.test.tsx/
// VehicleDetail.test.tsx's own harness pattern).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

async function freshHarness() {
  vi.resetModules()
  const { getFleetPulseStore } = await import('../../../store/store.ts')
  const { AnomalyView } = await import('./AnomalyView.tsx')
  return { store: getFleetPulseStore(), AnomalyView }
}

afterEach(() => {
  cleanup()
})

describe('AnomalyView', () => {
  it('FR-29: shows an explicit empty state before any anomaly is logged — never blank', async () => {
    const { AnomalyView } = await freshHarness()
    render(<AnomalyView />)
    expect(screen.getByText('No anomalies detected this session')).toBeTruthy()
  })

  it('FR-29: every anomaly-log entry renders its truck id, rule/type, and timestamp, sourced only from obs.anomalyLog', async () => {
    const { store, AnomalyView } = await freshHarness()
    const readingTs = new Date('2026-08-19T10:00:00.000Z').getTime()
    store.getState().pushAnomalies([
      { ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 999, readingTs, arrivalTs: readingTs + 10 },
    ])

    render(<AnomalyView />)

    expect(screen.queryByText('No anomalies detected this session')).toBeNull()
    const row = screen.getByTestId(`anomaly-row-truck_7-${readingTs}-0`)
    expect(row.textContent).toContain('truck_7')
    expect(row.textContent).toContain('Speed sensor fault')
    expect(row.textContent).toContain('999')
    expect(row.textContent).toContain(new Date(readingTs).toLocaleTimeString())
  })

  it('renders every entry in the bounded log, newest reading-timestamp first, and falls back to the raw ruleId for an unrecognized rule', async () => {
    const { store, AnomalyView } = await freshHarness()
    store.getState().pushAnomalies([
      { ruleId: 'fuel-suspect-resolved', truckId: 'truck_1', rawValue: 0, readingTs: 1_000, arrivalTs: 1_000 },
      { ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 999, readingTs: 2_000, arrivalTs: 2_000 },
      { ruleId: 'future-rule-not-yet-known', truckId: 'truck_3', rawValue: 42, readingTs: 3_000, arrivalTs: 3_000 },
    ])

    render(<AnomalyView />)

    const rows = screen.getAllByTestId(/^anomaly-row-/)
    expect(rows).toHaveLength(3)
    // Newest readingTs first.
    expect(rows[0]!.textContent).toContain('truck_3')
    expect(rows[0]!.textContent).toContain('future-rule-not-yet-known') // unrecognized ruleId shown verbatim
    expect(rows[1]!.textContent).toContain('truck_7')
    expect(rows[2]!.textContent).toContain('truck_1')
  })

  it('AD-18: reflects a fresh pushAnomalies commit on rerender, without re-deriving anything itself', async () => {
    const { store, AnomalyView } = await freshHarness()
    const { rerender } = render(<AnomalyView />)
    expect(screen.getByText('No anomalies detected this session')).toBeTruthy()

    store.getState().pushAnomalies([
      { ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 999, readingTs: 5_000, arrivalTs: 5_000 },
    ])
    rerender(<AnomalyView />)

    expect(screen.queryByText('No anomalies detected this session')).toBeNull()
    expect(screen.getByTestId('anomaly-row-truck_7-5000-0')).toBeTruthy()
  })

  it('code-review patch: two anomalies sharing the same truckId+readingTs get distinct, individually-queryable testids', async () => {
    const { store, AnomalyView } = await freshHarness()
    store.getState().pushAnomalies([
      { ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 210, readingTs: 9_000, arrivalTs: 9_000 },
      { ruleId: 'speed-sensor-fault', truckId: 'truck_7', rawValue: 999, readingTs: 9_000, arrivalTs: 9_000 },
    ])

    render(<AnomalyView />)

    // Both share truckId+readingTs — only the trailing index differs. Each
    // must resolve to exactly one element (getByTestId throws on a
    // collision) and carry its own distinct raw value.
    const first = screen.getByTestId('anomaly-row-truck_7-9000-0')
    const second = screen.getByTestId('anomaly-row-truck_7-9000-1')
    expect(first).not.toBe(second)
    const rawValues = [first.textContent, second.textContent].map((text) => text?.includes('raw: 210'))
    expect(rawValues).toContain(true)
  })
})
