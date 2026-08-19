// FleetPulse — bounded-history -> SVG sparkline points helper (FR-21, AD-14)
//
// Mirrors `fleetOverview/project.ts`'s shape: a small, dependency-free
// coordinate helper (AD-14 — no chart library) that turns one signal's
// bounded, timestamp-sorted history into a `points` attribute string for an
// SVG `<polyline>`, auto-fit to that series' own value range — the same
// "auto-fit, never a hardcoded bound" convention `project.ts` uses for
// lat/lng.

export interface SparklinePoint {
  readingTs: number
  value: number
}

export const SPARKLINE_VIEWBOX_WIDTH = 200
export const SPARKLINE_VIEWBOX_HEIGHT = 40

/** Fraction of the viewBox reserved as empty margin on every side, mirroring
 * `project.ts`'s own `PADDING_FRACTION` — so a point at the exact edge of
 * the series' value range never touches the sparkline's own border. */
const PADDING_FRACTION = 0.1

/** Builds a `points` attribute string for an SVG `<polyline>`, left-to-right
 * in timestamp order, auto-fit to the series' own value range (min/max). A
 * flat series (every point sharing the same value, or a single point)
 * renders as a flat mid-height line rather than dividing by zero — same
 * degenerate-case handling as `project.ts`'s `createProjection`. Empty input
 * returns the empty string; the caller renders FR-5's "no trusted reading
 * yet" state instead of an empty chart. */
export function buildSparklinePoints(points: readonly SparklinePoint[]): string {
  if (points.length === 0) return ''

  const values = points.map((p) => p.value)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const valueSpread = maxValue - minValue

  const minTs = points[0]!.readingTs
  const maxTs = points[points.length - 1]!.readingTs
  const tsSpread = maxTs - minTs

  const paddedWidth = SPARKLINE_VIEWBOX_WIDTH * (1 - 2 * PADDING_FRACTION)
  const paddedHeight = SPARKLINE_VIEWBOX_HEIGHT * (1 - 2 * PADDING_FRACTION)
  const originX = SPARKLINE_VIEWBOX_WIDTH * PADDING_FRACTION
  const originY = SPARKLINE_VIEWBOX_HEIGHT * PADDING_FRACTION

  return points
    .map((point) => {
      const xFraction = tsSpread === 0 ? 0.5 : (point.readingTs - minTs) / tsSpread
      const yFraction = valueSpread === 0 ? 0.5 : (point.value - minValue) / valueSpread
      const x = originX + xFraction * paddedWidth
      // Inverted, same convention as project.ts: a higher value renders
      // nearer the top (smaller y) — a conventional chart orientation, not
      // SVG's default.
      const y = originY + (1 - yFraction) * paddedHeight
      return `${x},${y}`
    })
    .join(' ')
}
