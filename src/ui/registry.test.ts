// FleetPulse — widget registry tests (AD-6)

import { afterEach, describe, expect, it } from 'vitest'
import { getWidgets, registerWidget, resetRegistryForTests } from './registry.ts'

function Noop() {
  return null
}

describe('widget registry', () => {
  afterEach(() => {
    resetRegistryForTests()
  })

  it('registers a widget and returns it via getWidgets', () => {
    registerWidget({ id: 'a', title: 'A', component: Noop })
    expect(getWidgets()).toEqual([{ id: 'a', title: 'A', component: Noop }])
  })

  it('registering the same id twice throws (AD-6: a collision fails loudly rather than silently shadowing)', () => {
    registerWidget({ id: 'a', title: 'A', component: Noop })
    expect(() => registerWidget({ id: 'a', title: 'A again', component: Noop })).toThrow()
  })

  it('AD-6: adding a second widget never requires touching the first', () => {
    registerWidget({ id: 'a', title: 'A', component: Noop })
    registerWidget({ id: 'b', title: 'B', component: Noop })
    expect(getWidgets().map((w) => w.id).sort()).toEqual(['a', 'b'])
  })

  it('resetRegistryForTests clears every registration', () => {
    registerWidget({ id: 'a', title: 'A', component: Noop })
    resetRegistryForTests()
    expect(getWidgets()).toEqual([])
  })
})
