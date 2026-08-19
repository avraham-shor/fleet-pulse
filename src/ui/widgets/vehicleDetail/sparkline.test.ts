// FleetPulse — sparkline helper tests (FR-21)

import { describe, expect, it } from 'vitest'
import { buildSparklinePoints, SPARKLINE_VIEWBOX_WIDTH, SPARKLINE_VIEWBOX_HEIGHT } from './sparkline.ts'

describe('buildSparklinePoints', () => {
  it('FR-5: empty history returns the empty string', () => {
    expect(buildSparklinePoints([])).toBe('')
  })

  it('a single point renders as one coordinate, centered on both axes', () => {
    const points = buildSparklinePoints([{ readingTs: 0, value: 50 }])
    const [x, y] = points.split(',').map(Number)
    expect(x).toBeCloseTo(SPARKLINE_VIEWBOX_WIDTH / 2)
    expect(y).toBeCloseTo(SPARKLINE_VIEWBOX_HEIGHT / 2)
  })

  it('a flat series (every value identical) renders a flat mid-height line, never a division by zero', () => {
    const series = [
      { readingTs: 0, value: 40 },
      { readingTs: 1_000, value: 40 },
      { readingTs: 2_000, value: 40 },
    ]
    const points = buildSparklinePoints(series).split(' ')
    expect(points).toHaveLength(3)
    const ys = points.map((p) => Number(p.split(',')[1]))
    expect(new Set(ys).size).toBe(1) // all at the same y
  })

  it('the highest value renders nearest the top (smallest y) — conventional chart orientation', () => {
    const series = [
      { readingTs: 0, value: 0 },
      { readingTs: 1_000, value: 100 },
    ]
    const points = buildSparklinePoints(series).split(' ')
    const y0 = Number(points[0]!.split(',')[1])
    const y1 = Number(points[1]!.split(',')[1])
    expect(y1).toBeLessThan(y0)
  })

  it('points render left-to-right in ascending timestamp order', () => {
    const series = [
      { readingTs: 0, value: 10 },
      { readingTs: 500, value: 20 },
      { readingTs: 1_000, value: 5 },
    ]
    const points = buildSparklinePoints(series).split(' ')
    const xs = points.map((p) => Number(p.split(',')[0]))
    expect(xs[0]).toBeLessThan(xs[1]!)
    expect(xs[1]).toBeLessThan(xs[2]!)
  })

  it('every coordinate stays within the padded viewBox bounds', () => {
    const series = [
      { readingTs: 0, value: -50 },
      { readingTs: 1_000, value: 500 },
      { readingTs: 2_000, value: 0 },
    ]
    for (const pointStr of buildSparklinePoints(series).split(' ')) {
      const [x, y] = pointStr.split(',').map(Number)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(SPARKLINE_VIEWBOX_WIDTH)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(SPARKLINE_VIEWBOX_HEIGHT)
    }
  })
})
