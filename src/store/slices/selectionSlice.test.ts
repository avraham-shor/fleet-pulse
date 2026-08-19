// FleetPulse — selection slice tests (FR-20)

import { describe, expect, it } from 'vitest'
import { createFleetPulseStore } from '../store.ts'
import { selectSelectedTruckId } from './selectionSlice.ts'

describe('selectionSlice', () => {
  it('starts with no truck selected', () => {
    const store = createFleetPulseStore()
    expect(selectSelectedTruckId(store.getState())).toBeNull()
  })

  it('selectTruck sets the selected truck id', () => {
    const store = createFleetPulseStore()
    store.getState().selectTruck('truck_3')
    expect(selectSelectedTruckId(store.getState())).toBe('truck_3')
  })

  it('selectTruck(null) explicitly clears the selection', () => {
    const store = createFleetPulseStore()
    store.getState().selectTruck('truck_3')
    store.getState().selectTruck(null)
    expect(selectSelectedTruckId(store.getState())).toBeNull()
  })

  it('selecting a different truck replaces the previous selection', () => {
    const store = createFleetPulseStore()
    store.getState().selectTruck('truck_1')
    store.getState().selectTruck('truck_2')
    expect(selectSelectedTruckId(store.getState())).toBe('truck_2')
  })
})
