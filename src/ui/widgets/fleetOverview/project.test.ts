// FleetPulse — SVG projection math tests (AD-14)
//
// Pure functions, no React/DOM involved — runs in the default node
// environment (no jsdom pragma needed; that's reserved for UI-visible
// behavior per the spine's Consistency Conventions).

import { describe, expect, it } from 'vitest'
import { computeBounds, createProjection, isLatLng, SVG_VIEWBOX_HEIGHT, SVG_VIEWBOX_WIDTH } from './project.ts'

describe('computeBounds', () => {
  it('computes min/max lat/lng across points', () => {
    const bounds = computeBounds([
      { lat: 10, lng: 20 },
      { lat: 30, lng: 5 },
      { lat: 20, lng: 15 },
    ])
    expect(bounds).toEqual({ minLat: 10, maxLat: 30, minLng: 5, maxLng: 20 })
  })

  it('a single point is a zero-spread box on both axes', () => {
    expect(computeBounds([{ lat: 5, lng: 5 }])).toEqual({ minLat: 5, maxLat: 5, minLng: 5, maxLng: 5 })
  })

  it('an empty fleet gets a harmless default box, never a divide-by-zero downstream', () => {
    const bounds = computeBounds([])
    const project = createProjection(bounds)
    expect(() => project({ lat: 0, lng: 0 })).not.toThrow()
  })
})

describe('createProjection', () => {
  it('AD-14: auto-fits from the live bounds — south/west corner projects opposite north/east, y inverted for latitude', () => {
    const bounds = { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 }
    const project = createProjection(bounds)
    const southWest = project({ lat: 0, lng: 0 }) // lowest lat -> bottom of the grid (largest y)
    const northEast = project({ lat: 10, lng: 10 }) // highest lat -> top of the grid (smallest y)
    expect(southWest.y).toBeGreaterThan(northEast.y)
    expect(southWest.x).toBeLessThan(northEast.x)
    for (const p of [southWest, northEast]) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(SVG_VIEWBOX_WIDTH)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(SVG_VIEWBOX_HEIGHT)
    }
  })

  it('a zero-spread axis (every truck sharing a lat or lng) centers that axis instead of dividing by zero', () => {
    const bounds = { minLat: 5, maxLat: 5, minLng: 0, maxLng: 10 }
    const project = createProjection(bounds)
    const p1 = project({ lat: 5, lng: 0 })
    const p2 = project({ lat: 5, lng: 10 })
    expect(p1.y).toBe(p2.y) // same latitude -> same y, centered rather than NaN
    expect(p1.x).not.toBe(p2.x)
  })

  it('padding keeps an edge point off the viewBox border', () => {
    const bounds = { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 }
    const project = createProjection(bounds)
    const corner = project({ lat: 0, lng: 0 })
    expect(corner.x).toBeGreaterThan(0)
    expect(corner.y).toBeLessThan(SVG_VIEWBOX_HEIGHT)
  })
})

describe('isLatLng', () => {
  it('accepts a {lat, lng} shape', () => {
    expect(isLatLng({ lat: 1, lng: 2 })).toBe(true)
  })

  it('rejects non-position shapes', () => {
    expect(isLatLng(null)).toBe(false)
    expect(isLatLng(42)).toBe(false)
    expect(isLatLng({ lat: 1 })).toBe(false)
    expect(isLatLng({ lat: '1', lng: 2 })).toBe(false)
  })
})
