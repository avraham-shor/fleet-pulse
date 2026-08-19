// @vitest-environment jsdom
// FleetPulse — TrustBadge tests (trust-model.md, AD-3)
//
// Testing Library's own queries + Vitest's built-in matchers only — no
// @testing-library/jest-dom (story boundary: no new dependency).

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TrustBadge } from './TrustBadge.tsx'
import type { EffectiveTrust } from '../store/selectors/effectiveTrust.ts'

afterEach(() => {
  cleanup()
})

describe('TrustBadge', () => {
  it('FR-5: null renders the cold-start "no trusted reading yet" text, not a badge over a missing value', () => {
    render(<TrustBadge trust={null} />)
    expect(screen.getByText('No trusted reading yet')).toBeTruthy()
  })

  const cases: Array<[EffectiveTrust, string]> = [
    ['trusted', 'Trusted'],
    ['suspect', 'Validating'],
    ['sensor-fault', 'Sensor fault'],
    ['stale', 'Stale'],
    ['degraded', 'Degraded'],
  ]

  it.each(cases)('renders the %s trust state as "%s"', (trust, label) => {
    render(<TrustBadge trust={trust} />)
    expect(screen.getByText(label)).toBeTruthy()
  })
})
