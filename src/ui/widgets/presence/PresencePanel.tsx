// FleetPulse — dispatcher presence widget (FR-16, FR-17, FR-18, AD-6)
//
// Three jobs in one panel, per the story's "Never: touch FleetOverview.tsx
// for viewing indicators" boundary — a dropdown here covers FR-18 instead:
// (1) a name input + Register button — "You: {name}" is local component
// state only, optimistic on submit (AD-17: this client's own identity
// never enters the presence slice); (2) the active-dispatcher list, read
// from `selectOtherDispatchers` — every entry there is, by construction,
// some *other* dispatcher; (3) a viewing `<select>` (options from
// `selectFleetTrucks`, fleetSlice.ts:48) that sends through the WS
// manager's send-only facade — `ui/` never imports transport directly
// (AD-1).
//
// Server-originated names render as plain JSX text nodes only (NFR-8) —
// no `dangerouslySetInnerHTML` anywhere in this file.

import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { getFleetPulseStore } from '../../../store/store.ts'
import { selectOtherDispatchers } from '../../../store/slices/presenceSlice.ts'
import { selectFleetTrucks, selectFleetFetchStatus } from '../../../store/slices/fleetSlice.ts'
import { getWsSendFacade } from '../../../transport/ws-manager.ts'
import { registerWidget } from '../../registry.ts'
import styles from './PresencePanel.module.css'

const useFleetPulseStore = getFleetPulseStore()

/** The viewing `<select>`'s "None" option value — mapped to `truckId: null`
 * on send (FR-18's explicit clear), never confused with a real truck id
 * since wire truck ids are always `truck_N` (never the empty string). */
const VIEWING_NONE = ''

export function PresencePanel() {
  // Selecting the raw records (referentially stable — only replaced on an
  // actual commit) and deriving the sorted arrays locally via `useMemo`,
  // rather than subscribing with `selectOtherDispatchers`/`selectFleetTrucks`
  // directly: both build a fresh array on every call, and Zustand's
  // `useSyncExternalStore`-backed hook compares snapshots by reference — a
  // selector that never returns the same reference twice re-triggers a
  // "changed" render every time, which starves out into React's "Maximum
  // update depth exceeded" guard (same pitfall FleetOverview.tsx's own
  // comment documents).
  const presenceDispatchers = useFleetPulseStore((state) => state.presence.dispatchers)
  const fleetTrucks = useFleetPulseStore((state) => state.fleet.trucks)
  const fleetFetchStatus = useFleetPulseStore(selectFleetFetchStatus)
  const otherDispatchers = useMemo(
    () => selectOtherDispatchers({ presence: { dispatchers: presenceDispatchers } }),
    [presenceDispatchers],
  )
  const trucks = useMemo(
    () => selectFleetTrucks({ fleet: { trucks: fleetTrucks, fetchStatus: fleetFetchStatus } }),
    [fleetTrucks, fleetFetchStatus],
  )

  const [nameInput, setNameInput] = useState('')
  // "Registered as X" is local state only — never written to the presence
  // slice (AD-17). `null` until the first successful submit.
  const [registeredAs, setRegisteredAs] = useState<string | null>(null)
  const [viewingSelection, setViewingSelection] = useState<string>(VIEWING_NONE)

  function handleRegisterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = nameInput.trim()
    if (trimmed === '') return
    // Optimistic: the send-only facade is fire-and-forget (no ack this
    // widget waits on) — `registered` handling and any presence rebuild
    // flow through the store on their own via app/'s wiring.
    const facade = getWsSendFacade()
    facade?.register(trimmed)
    setRegisteredAs(trimmed)
    // server.js's handleRegister (Design Notes) always mints a fresh
    // dispatcherId and a brand-new presence entry with viewingTruckId:
    // null, even for a same-name re-register — so without this, every
    // register submit would silently make this dispatcher's previously-
    // visible "viewing truck_X" status vanish for every peer until the
    // next manual selector change. Re-send it under the new identity so
    // it survives, using only the existing {register, sendViewing} facade.
    if (viewingSelection !== VIEWING_NONE) {
      facade?.sendViewing(viewingSelection)
    }
  }

  function handleViewingChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value
    setViewingSelection(value)
    getWsSendFacade()?.sendViewing(value === VIEWING_NONE ? null : value)
  }

  return (
    <div className={styles.wrapper}>
      <form className={styles.registerRow} onSubmit={handleRegisterSubmit}>
        <label className={styles.label} htmlFor="presence-name-input">
          Your name
        </label>
        <input
          id="presence-name-input"
          className={styles.input}
          type="text"
          value={nameInput}
          onChange={(event) => setNameInput(event.target.value)}
          placeholder="Dispatcher name"
        />
        <button className={styles.button} type="submit">
          Register
        </button>
      </form>
      <p className={styles.status}>
        {registeredAs === null ? 'Not registered yet' : (
          <>
            You: <strong>{registeredAs}</strong>
          </>
        )}
      </p>

      <div className={styles.viewingRow}>
        <label className={styles.label} htmlFor="presence-viewing-select">
          Viewing
        </label>
        <select
          id="presence-viewing-select"
          className={styles.select}
          value={viewingSelection}
          onChange={handleViewingChange}
        >
          <option value={VIEWING_NONE}>None</option>
          {trucks.map((truck) => (
            <option key={truck.truckId} value={truck.truckId}>
              {truck.truckId}
            </option>
          ))}
        </select>
      </div>

      <ul className={styles.list}>
        {otherDispatchers.length === 0 && <li className={styles.empty}>No other dispatchers active</li>}
        {otherDispatchers.map((dispatcher) => (
          <li key={dispatcher.dispatcherId} className={styles.row}>
            <span className={styles.name}>{dispatcher.name}</span>
            <span className={styles.viewing}>
              {dispatcher.viewingTruckId === null ? 'Not viewing a truck' : `Viewing ${dispatcher.viewingTruckId}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

registerWidget({ id: 'presence', title: 'Dispatcher presence', component: PresencePanel })
