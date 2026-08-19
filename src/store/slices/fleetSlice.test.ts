// FleetPulse — fleet slice tests (FR-1, FR-2, FR-22, FR-32, CM1)

import { describe, expect, it } from 'vitest'
import { createFleetPulseStore } from '../store.ts'
import { selectFleetFetchStatus, selectFleetTrucks, selectTruckAlerts } from './fleetSlice.ts'
import type { Truck, TruckAlert } from '../../contract/rest.ts'

function makeTruck(overrides: Partial<Truck> = {}): Truck {
  return {
    truckId: 'truck_1',
    status: 'active',
    lat: 32.1,
    lng: 34.8,
    speed: 40,
    fuel: 70,
    engineTemp: 75,
    mileage: 1_000,
    timestamp: 0,
    routeId: null,
    ...overrides,
  }
}

function makeAlert(overrides: Partial<TruckAlert> = {}): TruckAlert {
  return {
    truckId: 'truck_1',
    message: 'Check tire pressure',
    dispatcherId: 'dispatcher_1',
    dispatcherName: 'Alice',
    timestamp: 1_000,
    ...overrides,
  }
}

describe('fleetSlice', () => {
  it('starts pending with an empty roster', () => {
    const store = createFleetPulseStore()
    expect(selectFleetFetchStatus(store.getState())).toBe('pending')
    expect(selectFleetTrucks(store.getState())).toEqual([])
  })

  it('setFleet stores the roster keyed by truckId and flips status to ready', () => {
    const store = createFleetPulseStore()
    const trucks = [makeTruck({ truckId: 'truck_1' }), makeTruck({ truckId: 'truck_2', status: 'idle' })]
    store.getState().setFleet(trucks)
    expect(selectFleetFetchStatus(store.getState())).toBe('ready')
    expect(selectFleetTrucks(store.getState())).toHaveLength(2)
    expect(selectFleetTrucks(store.getState()).find((t) => t.truckId === 'truck_2')?.status).toBe('idle')
  })

  it('setFleetFetchFailed flips status to error (I/O matrix: "fleet unavailable")', () => {
    const store = createFleetPulseStore()
    store.getState().setFleetFetchFailed()
    expect(selectFleetFetchStatus(store.getState())).toBe('error')
  })

  it('selectFleetTrucks sorts truckId numerically, not lexicographically (truck_10 after truck_9, not before truck_2)', () => {
    const store = createFleetPulseStore()
    store.getState().setFleet([
      makeTruck({ truckId: 'truck_10' }),
      makeTruck({ truckId: 'truck_2' }),
      makeTruck({ truckId: 'truck_1' }),
    ])
    expect(selectFleetTrucks(store.getState()).map((t) => t.truckId)).toEqual(['truck_1', 'truck_2', 'truck_10'])
  })

  it('FR-32: addTruckAlert appends to that truck\'s alert buffer, visible via selectTruckAlerts', () => {
    const store = createFleetPulseStore()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    store.getState().addTruckAlert(makeAlert({ message: 'Low fuel' }))
    expect(selectTruckAlerts(store.getState(), 'truck_1')).toEqual([makeAlert({ message: 'Low fuel' })])
  })

  it('CM1: an alert for a truckId outside the current roster upserts a stub truck rather than being dropped', () => {
    const store = createFleetPulseStore()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1' })])
    expect(selectFleetTrucks(store.getState()).find((t) => t.truckId === 'truck_99')).toBeUndefined()

    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_99', timestamp: 5_000 }))

    const stub = selectFleetTrucks(store.getState()).find((t) => t.truckId === 'truck_99')
    expect(stub).toBeDefined()
    expect(stub?.timestamp).toBe(5_000)
    expect(selectTruckAlerts(store.getState(), 'truck_99')).toHaveLength(1)
  })

  it('a second alert for an already-known truck does not overwrite the existing roster entry with a stub', () => {
    const store = createFleetPulseStore()
    store.getState().setFleet([makeTruck({ truckId: 'truck_1', status: 'maintenance' })])
    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_1' }))
    expect(selectFleetTrucks(store.getState()).find((t) => t.truckId === 'truck_1')?.status).toBe('maintenance')
  })

  it('alerts for two different trucks land in independent buffers', () => {
    const store = createFleetPulseStore()
    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_1', message: 'A' }))
    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_2', message: 'B' }))
    expect(selectTruckAlerts(store.getState(), 'truck_1')).toHaveLength(1)
    expect(selectTruckAlerts(store.getState(), 'truck_2')).toHaveLength(1)
    expect(selectTruckAlerts(store.getState(), 'truck_1')[0]?.message).toBe('A')
  })

  it('selectTruckAlerts on a truck with no alerts yet reads as an empty array, not a crash', () => {
    const store = createFleetPulseStore()
    expect(selectTruckAlerts(store.getState(), 'truck_1')).toEqual([])
  })

  it('code-review regression: addTruckAlert gives the per-truck buffer a fresh object identity on every push, not the same mutated-in-place reference', () => {
    const store = createFleetPulseStore()
    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_1', message: 'First' }))
    const firstBufferRef = store.getState().fleet.alerts['truck_1']

    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_1', message: 'Second' }))
    const secondBufferRef = store.getState().fleet.alerts['truck_1']

    expect(secondBufferRef).not.toBe(firstBufferRef)
    expect(selectTruckAlerts(store.getState(), 'truck_1').map((a) => a.message)).toEqual(['First', 'Second'])
  })

  it('FR-33: resetFleetAlerts wipes every per-truck alert buffer back to empty', () => {
    const store = createFleetPulseStore()
    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_1' }))
    store.getState().addTruckAlert(makeAlert({ truckId: 'truck_2' }))
    expect(selectTruckAlerts(store.getState(), 'truck_1')).toHaveLength(1)

    store.getState().resetFleetAlerts()

    expect(selectTruckAlerts(store.getState(), 'truck_1')).toEqual([])
    expect(selectTruckAlerts(store.getState(), 'truck_2')).toEqual([])
    expect(store.getState().fleet.alerts).toEqual({})
    // The roster itself (including any CM1 stub truck) is untouched.
    expect(selectFleetTrucks(store.getState()).find((t) => t.truckId === 'truck_1')).toBeDefined()
  })
})
