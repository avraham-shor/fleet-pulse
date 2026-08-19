// FleetPulse — global degraded-mode banner (FR-26, AD-9)
//
// A pure rendering of the health slice's two named conditions — nothing
// here infers or computes degraded state itself (AD-9). Mounted once in
// `App.tsx`'s shell, not through the widget registry (Design Notes): it's
// global dashboard chrome, not a per-truck panel, so it doesn't fit the
// registry's "three independent, individually-erroring panels" model.
// Names *what* is degraded (FR-26 — "old data is never presented as
// fresh," but which source is stale must be explicit) rather than a single
// opaque flag; renders nothing while both conditions are healthy.

import { getFleetPulseStore } from '../store/store.ts'
import styles from './DegradedBanner.module.css'

const useFleetPulseStore = getFleetPulseStore()

const CONDITION_LABELS = {
  telemetryStreamDown: 'telemetry stream down',
  fleetFetchFailing: 'fleet fetches failing',
} as const

export function DegradedBanner() {
  const telemetryStreamDown = useFleetPulseStore((state) => state.health.telemetryStreamDown)
  const fleetFetchFailing = useFleetPulseStore((state) => state.health.fleetFetchFailing)

  if (!telemetryStreamDown && !fleetFetchFailing) return null

  const reasons: string[] = []
  if (telemetryStreamDown) reasons.push(CONDITION_LABELS.telemetryStreamDown)
  if (fleetFetchFailing) reasons.push(CONDITION_LABELS.fleetFetchFailing)

  return (
    <div className={styles.banner} role="alert" data-testid="degraded-banner">
      <strong>Degraded mode:</strong> {reasons.join(' · ')}
    </div>
  )
}
