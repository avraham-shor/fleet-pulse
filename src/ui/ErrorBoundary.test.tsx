// @vitest-environment jsdom
// FleetPulse — ErrorBoundary tests (FR-28)

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary.tsx'

afterEach(() => {
  cleanup()
})

function Throws(): never {
  throw new Error('boom')
}

function Fine() {
  return <div>fine</div>
}

describe('ErrorBoundary', () => {
  it('FR-28: a throwing widget shows a contained fallback naming the widget', () => {
    // React logs the caught error to the console in dev by default; the
    // spy keeps test output clean without hiding a genuine assertion
    // failure (it's restored at the end of the test, not globally).
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary widgetTitle="Fleet overview">
        <Throws />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toContain('Fleet overview')
    consoleError.mockRestore()
  })

  it('FR-28: one widget throwing never takes down a sibling widget rendered in its own boundary', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <>
        <ErrorBoundary widgetTitle="Broken widget">
          <Throws />
        </ErrorBoundary>
        <ErrorBoundary widgetTitle="Healthy widget">
          <Fine />
        </ErrorBoundary>
      </>,
    )
    expect(screen.getByText('fine')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Broken widget')
    consoleError.mockRestore()
  })
})
