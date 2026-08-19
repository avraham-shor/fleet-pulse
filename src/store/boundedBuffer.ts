// FleetPulse — the one capped-collection utility (AD-10)
//
// Every in-memory collection this story owns (per-signal telemetry
// history, the anomaly log) is created via this one factory — an uncapped
// collection is a review defect (AD-10). Sorted insertion happens once,
// here, at commit time — never at render.

export interface BoundedBuffer<T> {
  /** Inserts one item, evicting the oldest (by ordering key, or by push
   * order if no key was given) once `cap` is exceeded. Never grows past
   * `cap`. */
  push(item: T): void
  /** A snapshot array — ascending by ordering key when one was given,
   * otherwise in push order. Safe to hold onto; never mutated in place. */
  toArray(): readonly T[]
  size(): number
  clear(): void
}

export interface CreateBoundedBufferOptions<T> {
  /** Maximum number of items retained. */
  cap: number
  /** When given, `push` inserts in sorted position (ascending) instead of
   * always appending, and eviction always drops the smallest-key item —
   * "the timestamp-oldest end" (AD-10) — regardless of insertion order.
   * Telemetry history and the anomaly log both key on `readingTs`. Omit
   * for a plain arrival-order ring buffer. */
  orderingKey?: (item: T) => number
}

export function createBoundedBuffer<T>(options: CreateBoundedBufferOptions<T>): BoundedBuffer<T> {
  const cap = Math.max(0, options.cap)
  const orderingKey = options.orderingKey
  let items: T[] = []

  function insertSorted(item: T, key: (i: T) => number): void {
    const value = key(item)
    let lo = 0
    let hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (key(items[mid]!) <= value) lo = mid + 1
      else hi = mid
    }
    items.splice(lo, 0, item)
  }

  return {
    push(item) {
      if (cap === 0) return
      if (orderingKey) insertSorted(item, orderingKey)
      else items.push(item)
      // Sorted mode: index 0 is always the smallest key (timestamp-oldest)
      // once sorted, so evicting from the front evicts the oldest-by-key
      // entry either way — the same eviction call works for both modes.
      if (items.length > cap) items.shift()
    },
    toArray() {
      // A defensive copy — `push()` mutates `items` in place (`.push`,
      // `.splice`, `.shift()`), so returning the live array would let it
      // silently change out from under any caller still holding a prior
      // snapshot, and would defeat reference-equality memoization
      // (React/Zustand) keyed on it.
      return [...items]
    },
    size() {
      return items.length
    },
    clear() {
      items = []
    },
  }
}
