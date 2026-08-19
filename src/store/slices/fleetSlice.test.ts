// FleetPulse — fleet slice tests (FR-1, FR-2)

import { describe, expect, it } from 'vitest'
import { createFleetPulseStore } from '../store.ts'
import { selectFleetFetchStatus, selectFleetTrucks } from './fleetSlice.ts'
import type { Truck } from '../../contract/rest.ts'

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
})
