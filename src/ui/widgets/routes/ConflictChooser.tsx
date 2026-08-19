// FleetPulse — shared inline conflict chooser (FR-13, story 8's CAP-5)
//
// One presentational component, reached identically whichever route
// mutation 409s — transition, cancel, or reassign (`RoutesPanel.tsx`'s
// `RouteRow` is the sole caller, proving the one shared path FR-13 asks
// for). Driven only by the failure's own `conflictingDispatcher`/
// `currentRoute` props — never from store state — so the chooser renders
// correctly no matter when the matching WS echo happens to land (attribution
// is guaranteed by the 409 body itself, per FR-13). No modal library, no
// npm dependency: inline JSX mirroring `RouteRow`'s existing two-stage
// arm/confirm visual language (Design Notes).
//
// Adopt and Back out are mechanically identical under the hood (clear local
// state, send no request — routes have no mergeable fields: `status`/
// `truckId` are exclusive one-value-wins mutations and `destination` never
// changes post-create) but are offered as two distinctly labeled
// affordances for dispatcher clarity, not two implementations (Design
// Notes). Server-originated text (names, destination, status) renders as
// plain JSX text nodes only — no `dangerouslySetInnerHTML` (NFR-8).

import type { Route, RouteActor } from '../../../contract/rest.ts'
import styles from './RoutesPanel.module.css'

export interface ConflictChooserProps {
  conflictingDispatcher: RouteActor
  currentRoute: Route
  /** What the acting dispatcher was trying to do (e.g. "Cancel", "Reassign
   * to truck_2") — rendered side by side with the current server state so
   * both are visible at once (FR-13's "side by side"). */
  myIntentLabel: string
  /** Clears the row's armed/failure state and sends no request — accept
   * the other dispatcher's change as-is. */
  onAdopt: () => void
  /** Resubmits the same intended mutation with `If-Match` set to
   * `currentRoute.version` (the fresh version from this same 409 body). */
  onReapply: () => void
  /** Clears the row's armed/failure state and sends no request — same
   * effect as Adopt, offered separately for dispatcher clarity. */
  onBackOut: () => void
}

export function ConflictChooser({
  conflictingDispatcher,
  currentRoute,
  myIntentLabel,
  onAdopt,
  onReapply,
  onBackOut,
}: ConflictChooserProps) {
  return (
    <div className={styles.conflict} role="alert" data-testid="conflict-chooser">
      <p className={styles.conflictMessage}>
        <strong>{conflictingDispatcher.name}</strong> already changed this route — it is now at{' '}
        <strong>version {currentRoute.version}</strong>, status <strong>{currentRoute.status}</strong>.
      </p>
      <p className={styles.conflictMessage}>
        Your intended change: <strong>{myIntentLabel}</strong>.
      </p>
      <div className={styles.actionsRow}>
        <button type="button" className={styles.button} onClick={onAdopt}>
          Use their version
        </button>
        <button type="button" className={styles.button} onClick={onReapply}>
          Re-apply
        </button>
        <button type="button" className={styles.button} onClick={onBackOut}>
          Never mind
        </button>
      </div>
    </div>
  )
}
