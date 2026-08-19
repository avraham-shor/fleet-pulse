// FleetPulse — route lifecycle management widget (FR-10, 11, 12, 14, 15,
// 34, AD-6, AD-7, AD-16)
//
// Create / transition / reassign / cancel a route, plus the session-scoped
// audit trail. Calls `transport/api-client` directly (AD-7) through the one
// module-scope `routesApiClient` below, reading the acting dispatcher's id
// live via the WS send facade's optional `getDispatcherId` (AD-17, AD-1) —
// never captured once. Pessimistic UI throughout: a mutation's 2xx only
// clears this widget's own local in-flight/confirm state, never writes
// route data — the WS echo (routesSlice) is the sole writer (AD-16), so a
// created/transitioned/reassigned/cancelled route appears here only once
// its echo lands via `app/bootstrap.ts`.
//
// No modal library exists in the repo — destructive actions (cancel,
// reassign) and FR-34's warn-and-confirm use a minimal two-stage
// arm-then-confirm inline affordance instead (Design Notes): a first click
// arms a visible warning + a "confirm" labeled control, a second click
// actually submits. FR-34's warning condition is re-derived live from the
// store on every render — never cached — so it can never go stale while
// the create form is open.
//
// Server-originated text (dispatcher names, destinations) renders as plain
// JSX text nodes only (NFR-8) — no `dangerouslySetInnerHTML` anywhere here.

import { useMemo, useState, type FormEvent } from 'react'
import { getFleetPulseStore } from '../../../store/store.ts'
import { selectRoutes, selectAuditTrail } from '../../../store/slices/routesSlice.ts'
import { selectFleetTrucks, selectFleetFetchStatus } from '../../../store/slices/fleetSlice.ts'
import { createApiClient, type TransportFailure } from '../../../transport/api-client.ts'
import { getWsSendFacade } from '../../../transport/ws-manager.ts'
import type { Route, RouteStatus, Truck } from '../../../contract/rest.ts'
import { registerWidget } from '../../registry.ts'
import styles from './RoutesPanel.module.css'

const useFleetPulseStore = getFleetPulseStore()

/** The one module-scope client this widget mutates through (AD-7) — reads
 * the session-scoped dispatcher id live on every call via the WS send
 * facade's optional `getDispatcherId` (AD-17), never captured once, so a
 * fresh registration mid-session is picked up by the very next mutation. */
const routesApiClient = createApiClient({
  getDispatcherId: () => getWsSendFacade()?.getDispatcherId?.() ?? null,
})

/** Mirrors server.js's `LEGAL_TRANSITIONS` (server.js:394-399) — the UI
 * offers only transitions legal from a route's current status. */
const ROUTE_LEGAL_TRANSITIONS: Record<RouteStatus, RouteStatus[]> = {
  assigned: ['in-progress', 'cancelled'],
  'in-progress': ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

const TRANSITION_LABELS: Record<RouteStatus, string> = {
  assigned: 'Mark assigned',
  'in-progress': 'Start (in progress)',
  completed: 'Complete',
  cancelled: 'Cancel',
}

function describeFailure(failure: TransportFailure): string {
  switch (failure.kind) {
    case 'conflict':
      return `${failure.body.conflictingDispatcher.name} already changed this route (now at version ${failure.body.currentRoute.version}). Reload and retry.`
    case 'retryable':
      return `Server busy — retry in ${failure.retryAfterSeconds}s.`
    case 'error':
      return failure.body.message
  }
}

function findActiveRouteForTruck(routes: Route[], truckId: string): Route | null {
  return routes.find((route) => route.truckId === truckId && (route.status === 'assigned' || route.status === 'in-progress')) ?? null
}

interface CreateRouteFormProps {
  trucks: Truck[]
  routes: Route[]
}

function CreateRouteForm({ trucks, routes }: CreateRouteFormProps) {
  const [truckId, setTruckId] = useState('')
  const [destination, setDestination] = useState('')
  const [confirmArmed, setConfirmArmed] = useState(false)
  const [inFlight, setInFlight] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedTruck = trucks.find((truck) => truck.truckId === truckId) ?? null
  // FR-34: re-derived live from the store on every render — never cached —
  // so the warning can never go stale while this form is open.
  const activeRoute = truckId ? findActiveRouteForTruck(routes, truckId) : null
  const needsWarnConfirm = selectedTruck !== null && (selectedTruck.status === 'maintenance' || activeRoute !== null)

  function resetArmState() {
    if (confirmArmed) setConfirmArmed(false)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedDestination = destination.trim()
    if (truckId === '' || trimmedDestination === '') {
      setError('Choose a truck and enter a destination.')
      return
    }
    if (needsWarnConfirm && !confirmArmed) {
      // First click just arms the warning — no request sent yet (FR-34).
      setConfirmArmed(true)
      setError(null)
      return
    }
    setError(null)
    setInFlight(true)
    const result = await routesApiClient.createRoute({ truckId, destination: trimmedDestination })
    setInFlight(false)
    setConfirmArmed(false)
    if (!result.ok) {
      setError(describeFailure(result.failure))
      return
    }
    // Pessimistic UI: success only clears this form's local state — the
    // route itself appears once the route_assigned echo lands (AD-16).
    setTruckId('')
    setDestination('')
  }

  return (
    <form className={styles.createForm} onSubmit={handleSubmit}>
      <h2 className={styles.heading}>Create route</h2>
      <div className={styles.fieldRow}>
        <label className={styles.label} htmlFor="routes-create-truck">
          Truck
        </label>
        <select
          id="routes-create-truck"
          className={styles.select}
          value={truckId}
          onChange={(event) => {
            setTruckId(event.target.value)
            resetArmState()
          }}
        >
          <option value="">Select a truck</option>
          {trucks.map((truck) => (
            <option key={truck.truckId} value={truck.truckId}>
              {truck.truckId} ({truck.status})
            </option>
          ))}
        </select>
      </div>
      <div className={styles.fieldRow}>
        <label className={styles.label} htmlFor="routes-create-destination">
          Destination
        </label>
        <input
          id="routes-create-destination"
          className={styles.input}
          type="text"
          value={destination}
          onChange={(event) => {
            setDestination(event.target.value)
            resetArmState()
          }}
          placeholder="Destination"
        />
      </div>

      {selectedTruck !== null && needsWarnConfirm && (
        <p className={styles.warning} role="alert">
          {selectedTruck.status === 'maintenance' && <>Truck {selectedTruck.truckId} is in maintenance. </>}
          {activeRoute !== null && (
            <>
              Truck {selectedTruck.truckId} already has an active route to{' '}
              <strong>{activeRoute.destination}</strong>, assigned by <strong>{activeRoute.createdBy.name}</strong>.{' '}
            </>
          )}
          {confirmArmed ? 'Click "Confirm create" to proceed anyway.' : 'Creating another route needs confirmation.'}
        </p>
      )}
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <button className={needsWarnConfirm && confirmArmed ? styles.buttonDanger : styles.button} type="submit" disabled={inFlight}>
        {inFlight ? 'Creating…' : needsWarnConfirm && confirmArmed ? 'Confirm create' : 'Create route'}
      </button>
    </form>
  )
}

interface RouteRowProps {
  route: Route
  trucks: Truck[]
}

function RouteRow({ route, trucks }: RouteRowProps) {
  const [reassignTarget, setReassignTarget] = useState('')
  const [reassignArmed, setReassignArmed] = useState(false)
  const [cancelArmed, setCancelArmed] = useState(false)
  const [inFlight, setInFlight] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Defensive fallback: an unrecognized `route.status` (e.g. a future wire
  // value this build doesn't know about) must never throw during render —
  // it just offers no transitions.
  const legalTransitions = ROUTE_LEGAL_TRANSITIONS[route.status] ?? []
  const isNonTerminal = route.status === 'assigned' || route.status === 'in-progress'
  const otherTrucks = trucks.filter((truck) => truck.truckId !== route.truckId)

  async function runMutation(mutation: () => ReturnType<typeof routesApiClient.updateRouteStatus>) {
    setError(null)
    setInFlight(true)
    const result = await mutation()
    setInFlight(false)
    return result
  }

  async function handleTransition(nextStatus: RouteStatus) {
    if (nextStatus === 'cancelled') {
      if (!cancelArmed) {
        setCancelArmed(true)
        return
      }
    }
    const result = await runMutation(() => routesApiClient.updateRouteStatus(route.routeId, route.version, { status: nextStatus }))
    setCancelArmed(false)
    if (!result.ok) setError(describeFailure(result.failure))
    // Pessimistic UI: success clears only local in-flight/confirm state —
    // the row's own status updates once the route_updated echo lands.
  }

  async function handleReassign() {
    if (reassignTarget === '' || reassignTarget === route.truckId) return
    if (!reassignArmed) {
      setReassignArmed(true)
      return
    }
    const result = await runMutation(() => routesApiClient.reassignRoute(route.routeId, route.version, { truckId: reassignTarget }))
    setReassignArmed(false)
    if (result.ok) {
      // review finding, iteration 1: reset the target too, alongside the
      // confirm-state reset above, so a stale target can't silently
      // resubmit a same-truck reassign on the next click.
      setReassignTarget('')
    } else {
      setError(describeFailure(result.failure))
    }
  }

  return (
    <li className={styles.routeRow} data-testid={`route-row-${route.routeId}`}>
      <div className={styles.routeHeader}>
        <span className={styles.truckId}>{route.truckId}</span>
        <span className={styles.destination}>{route.destination}</span>
        <span className={styles.statusBadge} data-status={route.status}>
          {route.status}
        </span>
      </div>
      <p className={styles.meta}>
        v{route.version} · last updated by {route.updatedBy.name}
      </p>

      {legalTransitions.length > 0 && (
        <div className={styles.actionsRow}>
          {legalTransitions.map((target) => (
            <button
              key={target}
              type="button"
              className={target === 'cancelled' ? styles.buttonDanger : styles.button}
              disabled={inFlight}
              onClick={() => void handleTransition(target)}
            >
              {inFlight
                ? 'Saving…'
                : target === 'cancelled' && cancelArmed
                  ? 'Confirm cancel'
                  : TRANSITION_LABELS[target]}
            </button>
          ))}
        </div>
      )}

      {isNonTerminal && otherTrucks.length > 0 && (
        <div className={styles.actionsRow}>
          <select
            aria-label={`Reassign ${route.routeId} to`}
            className={styles.select}
            value={reassignTarget}
            disabled={inFlight}
            onChange={(event) => {
              setReassignTarget(event.target.value)
              setReassignArmed(false)
            }}
          >
            <option value="">Reassign to…</option>
            {otherTrucks.map((truck) => (
              <option key={truck.truckId} value={truck.truckId}>
                {truck.truckId}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.button}
            disabled={inFlight || reassignTarget === ''}
            onClick={() => void handleReassign()}
          >
            {inFlight ? 'Saving…' : reassignArmed ? 'Confirm reassign' : 'Reassign'}
          </button>
        </div>
      )}

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

export function RoutesPanel() {
  // Field-access selectors only (referentially stable until an actual
  // commit) — the same convention FleetOverview.tsx/PresencePanel.tsx use,
  // to avoid Zustand's "changed every render" infinite-loop pitfall from a
  // selector that builds a fresh array/object on every call.
  const routesState = useFleetPulseStore((state) => state.routes)
  const fleetTrucks = useFleetPulseStore((state) => state.fleet.trucks)
  const fleetFetchStatus = useFleetPulseStore(selectFleetFetchStatus)

  const trucks = useMemo(
    () => selectFleetTrucks({ fleet: { trucks: fleetTrucks, fetchStatus: fleetFetchStatus } }),
    [fleetTrucks, fleetFetchStatus],
  )
  const routes = useMemo(() => selectRoutes({ routes: routesState }), [routesState])
  const auditTrail = useMemo(() => selectAuditTrail({ routes: routesState }), [routesState])

  return (
    <div className={styles.wrapper}>
      <CreateRouteForm trucks={trucks} routes={routes} />

      <div>
        <h2 className={styles.heading}>Active routes</h2>
        <ul className={styles.routeList}>
          {routes.length === 0 && <li className={styles.empty}>No routes yet</li>}
          {routes.map((route) => (
            <RouteRow key={route.routeId} route={route} trucks={trucks} />
          ))}
        </ul>
      </div>

      <div>
        <h2 className={styles.heading}>Audit trail</h2>
        <ul className={styles.auditList} data-testid="audit-trail">
          {auditTrail.length === 0 && <li className={styles.empty}>No route activity yet this session</li>}
          {auditTrail.map((entry, index) => (
            <li key={`${entry.routeId}-${entry.version}-${index}`} className={styles.auditRow} data-testid={`audit-row-${entry.routeId}-${entry.version}`}>
              <span className={styles.auditEvent}>{entry.eventType}</span>
              <span>{entry.truckId}</span>
              <span>
                → {entry.status} (v{entry.version})
              </span>
              <span>by {entry.actor.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

registerWidget({ id: 'routes', title: 'Route management', component: RoutesPanel })
