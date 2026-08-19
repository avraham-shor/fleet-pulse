// FleetPulse — lat/lng -> SVG coordinate projection (AD-14)
//
// No map library (AD-14): a truck's lat/lng projects onto a plain SVG
// viewBox, auto-fit from the *live* fleet's own coordinate range every
// render — never a hardcoded bound (server's MAP_LAT/LNG_* are
// server-internal, not a shared contract value, per server.js:130-134).
// Latitude increases northward but SVG y increases downward, so y is
// inverted here — otherwise the fleet would render upside down.

export interface LatLng {
  lat: number
  lng: number
}

export interface ProjectedPoint {
  x: number
  y: number
}

export interface ProjectionBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export const SVG_VIEWBOX_WIDTH = 1000
export const SVG_VIEWBOX_HEIGHT = 600

/** Fraction of the viewBox reserved as empty margin on every side, so a
 * marker at the exact edge of the live range never touches the grid's own
 * border. */
const PADDING_FRACTION = 0.08

/** Runtime shape check for a telemetry envelope's `value` — the store types
 * position's payload as `unknown` (one generic `Reading<unknown>` shape
 * serves every signal), so widgets narrow it themselves rather than
 * importing the pipeline's own `Position` type (`ui/` never imports
 * `pipeline/`, AD-1). `Number.isFinite` (not `typeof === 'number'` alone)
 * is required here: `NaN`/`Infinity` both pass `typeof x === 'number'`, and
 * since `computeBounds` folds every truck's position into one shared
 * bounding box, a single corrupted reading would otherwise poison every
 * truck's projected coordinates, not just the offending truck's marker. */
export function isLatLng(value: unknown): value is LatLng {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite((value as { lat?: unknown }).lat) &&
    Number.isFinite((value as { lng?: unknown }).lng)
  )
}

/** Computes the live fleet's own lat/lng bounds — the "auto-fit" half of
 * AD-14's rule. An empty or single-point fleet still produces a valid,
 * non-zero-size bounding box (no divide-by-zero downstream). */
export function computeBounds(points: readonly LatLng[]): ProjectionBounds {
  if (points.length === 0) {
    // An arbitrary, harmless default box — nothing is ever projected
    // against it, since the widget only renders a marker once at least one
    // truck has a live position.
    return { minLat: -1, maxLat: 1, minLng: -1, maxLng: 1 }
  }
  let minLat = points[0]!.lat
  let maxLat = points[0]!.lat
  let minLng = points[0]!.lng
  let maxLng = points[0]!.lng
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lng < minLng) minLng = p.lng
    if (p.lng > maxLng) maxLng = p.lng
  }
  return { minLat, maxLat, minLng, maxLng }
}

/** Builds a `project(latLng)` function auto-fit to `bounds`, padded so
 * points at the exact range edge don't touch the viewBox border. Handles
 * the degenerate zero-spread case (a single truck, or every truck sharing a
 * lat or lng) by centering that axis instead of dividing by zero. */
export function createProjection(bounds: ProjectionBounds): (point: LatLng) => ProjectedPoint {
  const latSpread = bounds.maxLat - bounds.minLat
  const lngSpread = bounds.maxLng - bounds.minLng

  const paddedWidth = SVG_VIEWBOX_WIDTH * (1 - 2 * PADDING_FRACTION)
  const paddedHeight = SVG_VIEWBOX_HEIGHT * (1 - 2 * PADDING_FRACTION)
  const originX = SVG_VIEWBOX_WIDTH * PADDING_FRACTION
  const originY = SVG_VIEWBOX_HEIGHT * PADDING_FRACTION

  return ({ lat, lng }) => {
    const xFraction = lngSpread === 0 ? 0.5 : (lng - bounds.minLng) / lngSpread
    const yFraction = latSpread === 0 ? 0.5 : (lat - bounds.minLat) / latSpread
    return {
      x: originX + xFraction * paddedWidth,
      // Inverted: higher latitude (further north) renders nearer the top
      // (smaller y) — a conventional map orientation, not SVG's default.
      y: originY + (1 - yFraction) * paddedHeight,
    }
  }
}
