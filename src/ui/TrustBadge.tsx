// FleetPulse — the one shared trust badge (trust-model.md, AD-3)
//
// Every widget that shows a value renders its trust through this component
// and nothing else — one CSS token set for the five states, so "exactly one
// state" stays visually true across every view (Consistency Conventions:
// "Trust styling"). Trust annotations render inline, never a modal (CM2).

import type { EffectiveTrust } from '../store/selectors/effectiveTrust.ts'
import styles from './TrustBadge.module.css'

export interface TrustBadgeProps {
  trust: EffectiveTrust | null
}

const LABELS: Record<EffectiveTrust, string> = {
  trusted: 'Trusted',
  suspect: 'Validating',
  'sensor-fault': 'Sensor fault',
  stale: 'Stale',
  degraded: 'Degraded',
}

/** `null` is not a sixth state — it's FR-5's cold-start case, "no trusted
 * reading yet" (first load, or just after a fleet reset): a distinct
 * textual treatment rather than a badge over a value that doesn't exist. */
export function TrustBadge({ trust }: TrustBadgeProps) {
  if (trust === null) {
    return (
      <span className={styles.badge} data-trust="none">
        No trusted reading yet
      </span>
    )
  }
  return (
    <span className={styles.badge} data-trust={trust}>
      {LABELS[trust]}
    </span>
  )
}
