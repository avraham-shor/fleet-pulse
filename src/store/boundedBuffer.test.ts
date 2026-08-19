// FleetPulse — boundedBuffer tests (AD-10)
//
// The one capped-collection utility backing every in-memory collection
// (NFR-3). Framework-free, node environment.

import { describe, expect, it } from 'vitest'
import { createBoundedBuffer } from './boundedBuffer.ts'

describe('createBoundedBuffer', () => {
  it('NFR-3: never exceeds cap — FIFO mode evicts the oldest-pushed entry', () => {
    const buffer = createBoundedBuffer<number>({ cap: 3 })
    buffer.push(1)
    buffer.push(2)
    buffer.push(3)
    expect(buffer.toArray()).toEqual([1, 2, 3])
    buffer.push(4)
    expect(buffer.size()).toBe(3)
    expect(buffer.toArray()).toEqual([2, 3, 4])
  })

  it('NFR-3: with an ordering key, evicts the smallest-key (oldest-by-key) entry regardless of push order', () => {
    const buffer = createBoundedBuffer<{ id: string; ts: number }>({ cap: 3, orderingKey: (item) => item.ts })
    buffer.push({ id: 'a', ts: 20 })
    buffer.push({ id: 'b', ts: 10 })
    buffer.push({ id: 'c', ts: 30 })
    // Sorted ascending by ts regardless of push order.
    expect(buffer.toArray().map((i) => i.id)).toEqual(['b', 'a', 'c'])

    // A new entry newer than all three pushes the oldest-by-key ('b', ts 10) out.
    buffer.push({ id: 'd', ts: 40 })
    expect(buffer.size()).toBe(3)
    expect(buffer.toArray().map((i) => i.id)).toEqual(['a', 'c', 'd'])
  })

  it('with an ordering key, a late-arriving entry with an old key still inserts in sorted position', () => {
    const buffer = createBoundedBuffer<{ ts: number }>({ cap: 5, orderingKey: (item) => item.ts })
    buffer.push({ ts: 10 })
    buffer.push({ ts: 30 })
    buffer.push({ ts: 20 }) // arrives "late" but timestamp-sorts in the middle
    expect(buffer.toArray().map((i) => i.ts)).toEqual([10, 20, 30])
  })

  it('clear() empties the buffer', () => {
    const buffer = createBoundedBuffer<number>({ cap: 3 })
    buffer.push(1)
    buffer.clear()
    expect(buffer.toArray()).toEqual([])
    expect(buffer.size()).toBe(0)
  })

  it('a cap of 0 accepts nothing', () => {
    const buffer = createBoundedBuffer<number>({ cap: 0 })
    buffer.push(1)
    expect(buffer.toArray()).toEqual([])
  })

  it('toArray() returns a snapshot — a previously captured array never mutates as later pushes/evictions happen', () => {
    const buffer = createBoundedBuffer<number>({ cap: 2 })
    buffer.push(1)
    buffer.push(2)
    const snapshot = buffer.toArray()
    expect(snapshot).toEqual([1, 2])

    buffer.push(3) // evicts 1, mutating the buffer's own internal array
    expect(buffer.toArray()).toEqual([2, 3])
    expect(snapshot).toEqual([1, 2]) // the earlier snapshot is untouched
  })
})
