// FleetPulse — dispatcher anomaly view (FR-29, AD-6, AD-18)
//
// Reads exclusively from `store.getState().obs.anomalyLog` — already fed
// live via the pipeline's `onAnomaly` -> `ingestAnomalies` ->
// `pushAnomaliesPure` chain (`store.ts:117,132`) — this widget never
// re-derives or re-detects an anomaly itself (Boundaries & Constraints).
// Every anomaly the pipeline has ever logged (sensor-fault rejections,
// fuel-suspect-window resolutions, AD-18) lands in this one bounded buffer;
// this panel is the dispatcher-facing aggregate view a dispatcher needs to
// judge "real problem or sensor bug" (FR-29's own framing), not a new
// detection surface (SPEC.md's explicit non-goal: no standalone
// anomaly-detection dashboard beyond this aggregated list).
//
// Registered like every other panel (`registerWidget`), so it gets the
// standard `ErrorBoundary` for free (FR-28).

import { useMemo } from 'react'
import { getFleetPulseStore } from '../../../store/store.ts'
import type { AnomalyEntry } from '../../../pipeline/types.ts'
import { registerWidget } from '../../registry.ts'
import styles from './AnomalyView.module.css'

const useFleetPulseStore = getFleetPulseStore()

/** Human-readable label for the raw `ruleId` strings the pipeline's
 * classifiers emit (speed.ts, fuel.ts) — a display-only lookup, never a
 * re-derivation of trust: the underlying entry (truck id, raw value,
 * timestamps) is rendered exactly as logged either way. An unrecognized
 * `ruleId` (a future rule this build doesn't know about) still renders,
 * verbatim, rather than being hidden. */
const RULE_LABELS: Record<string, string> = {
  'speed-sensor-fault': 'Speed sensor fault',
  'fuel-suspect-resolved': 'Fuel reading resolved',
}

function describeRule(ruleId: string): string {
  return RULE_LABELS[ruleId] ?? ruleId
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function AnomalyRow({ entry, index }: { entry: AnomalyEntry; index: number }) {
  // `data-testid` mirrors the exact same disambiguation the `key` below
  // uses (truckId + readingTs + index) — two anomalies sharing a
  // truckId+readingTs pair (code-review finding) would otherwise collide on
  // a testid scoped to just those two fields, even though `key` already
  // correctly told them apart.
  return (
    <li className={styles.row} data-testid={`anomaly-row-${entry.truckId}-${entry.readingTs}-${index}`}>
      <span className={styles.truckId}>{entry.truckId}</span>
      <span className={styles.rule}>{describeRule(entry.ruleId)}</span>
      <span className={styles.rawValue}>raw: {String(entry.rawValue)}</span>
      <span className={styles.timestamp}>{formatTimestamp(entry.readingTs)}</span>
    </li>
  )
}

export function AnomalyView() {
  // Field-access selector on `obs` itself, not `obs.anomalyLog` directly:
  // `pushAnomaliesPure` (obsSlice.ts) mutates the `BoundedBuffer` instance
  // in place via `.push()` and only ever replaces the *outer* `obs` object
  // (`{ ...obs }`) — so `state.obs.anomalyLog`'s own reference never
  // changes across a push, and a selector narrowed to it would never be
  // seen as "changed" by Zustand's snapshot comparison, silently freezing
  // this view at whatever anomalies existed on mount. `state.obs` itself
  // *is* replaced on every non-empty push (and deliberately left unchanged
  // for an empty one — obsSlice.ts's own no-op case), so selecting it is
  // what actually observes a fresh commit; RoutesPanel.tsx's `routesState`
  // selector follows the identical pattern for the same reason.
  const obsState = useFleetPulseStore((state) => state.obs)
  // Newest-first: a dispatcher scanning for "what just happened" cares most
  // about the most recent entries; `anomalyLog` itself stays sorted
  // oldest-first internally (readingTs ascending, AD-10) so this reverses
  // only the snapshot handed to render, never the buffer's own order.
  const entries = useMemo(() => [...obsState.anomalyLog.toArray()].reverse(), [obsState])

  return (
    <div className={styles.wrapper}>
      <h2 className={styles.heading}>Anomaly log</h2>
      {entries.length === 0 ? (
        <p className={styles.empty}>No anomalies detected this session</p>
      ) : (
        <ul className={styles.list} data-testid="anomaly-list">
          {entries.map((entry, index) => (
            // `readingTs` alone isn't guaranteed unique (two trucks' own
            // classifiers can share a timestamp) — `truckId` + `readingTs` +
            // the array index disambiguates without needing a synthetic id
            // this entry shape doesn't carry. `index` is threaded into
            // `AnomalyRow` too, so its `data-testid` uses the identical key.
            <AnomalyRow key={`${entry.truckId}-${entry.readingTs}-${index}`} entry={entry} index={index} />
          ))}
        </ul>
      )}
    </div>
  )
}

registerWidget({ id: 'anomaly-view', title: 'Anomaly log', component: AnomalyView })
