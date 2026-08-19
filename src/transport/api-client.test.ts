// FleetPulse — api-client tests (AD-7, AD-8's breaker clause, FR-16, FR-24,
// FR-25, NFR-4, NFR-5)
//
// Runs in the node environment (no React, no DOM) against an injected fake
// `fetch` plus injected `now`/`setTimeoutImpl` clocks — the breaker and
// auto-retry logic is driven by explicitly advancing a controlled clock,
// not real elapsed time or vitest's fake-timer/Date shims, so the
// mandated FR-25 case (3x503 opens; probe honors max(interval,
// Retry-After); success closes) is exact and fast.

import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './api-client.ts'
import type { ConflictErrorBody, Route, Truck } from '../contract/rest.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response
}

function make503(retryAfterSeconds: number) {
  return makeResponse(503, { error: 'fleet_unavailable', message: 'unavailable' }, { 'Retry-After': String(retryAfterSeconds) })
}

/** A fetch stand-in whose Retry-After-bearing 503 responses throw if
 * `.json()` is ever called — proves the header, never the body, is read. */
function make503NoBodyRead(retryAfterSeconds: number): Response {
  const headerMap = new Map([['retry-after', String(retryAfterSeconds)]])
  return {
    status: 503,
    ok: false,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => {
      throw new Error('Retry-After must be read from the header, not parsed from JSON')
    },
  } as unknown as Response
}

const SAMPLE_TRUCK: Truck = {
  truckId: 'truck_1',
  status: 'active',
  lat: 32.1,
  lng: 34.8,
  speed: 40,
  fuel: 80,
  engineTemp: 75,
  mileage: 1000,
  timestamp: 1000,
  routeId: null,
}

const SAMPLE_ROUTE: Route = {
  routeId: 'route_1',
  truckId: 'truck_1',
  status: 'assigned',
  version: 5,
  destination: 'Warehouse A',
  createdBy: { dispatcherId: 'dispatcher_abc', name: 'Alice' },
  createdAt: 1000,
  updatedAt: 1000,
  updatedBy: { dispatcherId: 'dispatcher_abc', name: 'Alice' },
}

/** Immediate setTimeout stand-in: the auto-retry loop's `sleep()` resolves
 * on the next microtask instead of waiting real/faked wall-clock time —
 * only `now()` (independently controlled below) governs breaker timing. */
const immediateSetTimeout = ((cb: () => void) => {
  cb()
  return 0 as unknown as ReturnType<typeof setTimeout>
}) as typeof setTimeout

describe('api-client — mutation gate', () => {
  it('FR-16: refuses a mutation locally with no live dispatcherId — no request sent', async () => {
    const fetchImpl = vi.fn()
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl })

    const result = await client.createRoute({ truckId: 'truck_1', destination: 'Depot' })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('error')
      expect(result.failure.kind === 'error' && result.failure.body.error).toBe('not_registered')
    }
  })

  it('NFR-4: injects X-Dispatcher-Id on every mutation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(201, SAMPLE_ROUTE))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    await client.createRoute({ truckId: 'truck_1', destination: 'Depot' })
    await client.sendTruckAlert('truck_1', { message: 'Low bridge' })

    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit
      expect((init.headers as Record<string, string>)['X-Dispatcher-Id']).toBe('dispatcher_abc')
    }
  })

  it('NFR-5: echoes If-Match on PATCH/reassign only, never on create or alert', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, SAMPLE_ROUTE))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    await client.createRoute({ truckId: 'truck_1', destination: 'Depot' })
    let init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['If-Match']).toBeUndefined()

    await client.updateRouteStatus('route_1', 5, { status: 'in-progress' })
    init = fetchImpl.mock.calls[1]![1] as RequestInit
    expect((init.headers as Record<string, string>)['If-Match']).toBe('5')

    await client.reassignRoute('route_1', 5, { truckId: 'truck_2' })
    init = fetchImpl.mock.calls[2]![1] as RequestInit
    expect((init.headers as Record<string, string>)['If-Match']).toBe('5')

    await client.sendTruckAlert('truck_1', { message: 'Low bridge' })
    init = fetchImpl.mock.calls[3]![1] as RequestInit
    expect((init.headers as Record<string, string>)['If-Match']).toBeUndefined()
  })

  it('FR-13: a 409 maps to {kind: "conflict", body} carrying the full body, never a raw error', async () => {
    const conflictBody: ConflictErrorBody = {
      error: 'version_conflict',
      message: 'stale',
      conflictingDispatcher: { dispatcherId: 'dispatcher_system', name: 'System' },
      currentRoute: SAMPLE_ROUTE,
    }
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, conflictBody))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    const result = await client.updateRouteStatus('route_1', 4, { status: 'in-progress' })
    expect(result).toEqual({ ok: false, failure: { kind: 'conflict', body: conflictBody } })
  })

  it('a 409 with a body missing required ConflictErrorBody fields degrades to a safe error, never a bad cast', async () => {
    // Same status code as a real conflict, but the body is missing
    // `conflictingDispatcher`/`currentRoute` — must not be trusted as-is.
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(409, { error: 'version_conflict', message: 'stale' }))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    const result = await client.updateRouteStatus('route_1', 4, { status: 'in-progress' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('error')
      expect(result.failure.kind === 'error' && result.failure.body.error).toBe('invalid_response')
    }
  })

  it('a 503 on a mutation maps to {kind: "retryable"}, reading Retry-After from the header only', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(make503NoBodyRead(7))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    const result = await client.sendTruckAlert('truck_1', { message: 'x' })
    expect(result).toEqual({ ok: false, failure: { kind: 'retryable', retryAfterSeconds: 7 } })
  })

  it('a 503 with no Retry-After header at all falls back to the breaker probe interval, not 0', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(503, { error: 'fleet_unavailable', message: 'x' }))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    const result = await client.sendTruckAlert('truck_1', { message: 'x' })
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'retryable', retryAfterSeconds: CLIENT_THRESHOLDS.BREAKER_PROBE_INTERVAL_MS / 1000 },
    })
  })

  it('a non-409/503 failure status maps to {kind: "error", body}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(400, { error: 'invalid_destination', message: 'required' }))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    const result = await client.createRoute({ truckId: 'truck_1', destination: '' })
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'error', body: { error: 'invalid_destination', message: 'required' } },
    })
  })

  it('a malformed response body degrades to a safe error result rather than throwing', async () => {
    const badJson = { status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new Error('boom') } }
    const fetchImpl = vi.fn().mockResolvedValue(badJson as unknown as Response)
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    const result = await client.createRoute({ truckId: 'truck_1', destination: 'Depot' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('error')
  })

  it('a thrown fetch error (network down) never escapes — normalized to {kind: "error"}', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('failed to fetch'))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    await expect(client.createRoute({ truckId: 'truck_1', destination: 'Depot' })).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'error' },
    })
  })

  it('a successful mutation returns {ok: true, data}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(201, SAMPLE_ROUTE))
    const client = createApiClient({ getDispatcherId: () => 'dispatcher_abc', fetchImpl })

    const result = await client.createRoute({ truckId: 'truck_1', destination: 'Depot' })
    expect(result).toEqual({ ok: true, data: SAMPLE_ROUTE })
  })
})

describe('api-client — GET /api/fleet + circuit breaker (FR-24, FR-25)', () => {
  it('FR-25 (mandated): 3x503 opens the breaker; the probe honors max(interval, Retry-After); a successful probe closes it', async () => {
    let currentTime = 1_000_000
    const now = () => currentTime

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))

    const client = createApiClient({ getDispatcherId: () => null, fetchImpl, now, setTimeoutImpl: immediateSetTimeout })

    expect(client.getBreakerState()).toBe('closed')
    const opened = await client.getFleet()
    expect(fetchImpl).toHaveBeenCalledTimes(3) // each completed attempt counts, retries included
    expect(client.getBreakerState()).toBe('open')
    expect(opened).toEqual({ ok: false, failure: { kind: 'retryable', retryAfterSeconds: 3 } })

    // FLEET_503_RETRY_AFTER_S (3s) < BREAKER_PROBE_INTERVAL_MS (10s) — the
    // probe must honor the longer of the two, not the server's own value.
    currentTime += CLIENT_THRESHOLDS.BREAKER_PROBE_INTERVAL_MS - 1
    const tooSoon = await client.getFleet()
    expect(fetchImpl).toHaveBeenCalledTimes(3) // still short-circuited locally — no network call
    expect(tooSoon.ok).toBe(false)

    currentTime += 1 // exactly at the probe time now
    fetchImpl.mockResolvedValueOnce(makeResponse(200, [SAMPLE_TRUCK]))
    const probed = await client.getFleet()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(probed).toEqual({ ok: true, data: [SAMPLE_TRUCK] })
    expect(client.getBreakerState()).toBe('closed')
  })

  it('FR-24: auto-retries a 503 per Retry-After while still pre-breaker, resolving without ever opening', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(makeResponse(200, [SAMPLE_TRUCK]))

    const client = createApiClient({ getDispatcherId: () => null, fetchImpl, setTimeoutImpl: immediateSetTimeout })

    const result = await client.getFleet()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ ok: true, data: [SAMPLE_TRUCK] })
    expect(client.getBreakerState()).toBe('closed')
  })

  it('a probe failure reschedules the next probe rather than closing the breaker', async () => {
    let currentTime = 0
    const now = () => currentTime
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl, now, setTimeoutImpl: immediateSetTimeout })
    await client.getFleet()
    expect(client.getBreakerState()).toBe('open')

    currentTime += CLIENT_THRESHOLDS.BREAKER_PROBE_INTERVAL_MS
    fetchImpl.mockResolvedValueOnce(make503(5))
    const failedProbe = await client.getFleet()
    expect(client.getBreakerState()).toBe('open')
    expect(failedProbe).toEqual({ ok: false, failure: { kind: 'retryable', retryAfterSeconds: 5 } })

    // The failed probe's own Retry-After (5s -> 5000ms) is shorter than the
    // probe interval (10s), so max(interval, retryAfter) still governs.
    currentTime += CLIENT_THRESHOLDS.BREAKER_PROBE_INTERVAL_MS - 1
    const stillTooSoon = await client.getFleet()
    expect(fetchImpl).toHaveBeenCalledTimes(4) // no new network call
    expect(stillTooSoon.ok).toBe(false)
  })

  it('a non-503 failure is never auto-retried and never counted toward the breaker', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(makeResponse(500, { error: 'internal', message: 'oops' }))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl, setTimeoutImpl: immediateSetTimeout })

    const result = await client.getFleet()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: false, failure: { kind: 'error', body: { error: 'internal', message: 'oops' } } })
    expect(client.getBreakerState()).toBe('closed')
  })

  it('FR-25: a non-503 failure resets the consecutive-failure streak, so a later 503 sequence does not inherit it', async () => {
    const fetchImpl = vi.fn()
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl, setTimeoutImpl: immediateSetTimeout })

    // Call 1: one 503 (streak -> 1), then a non-503 failure, which must
    // reset the streak to 0 before returning rather than leaving it at 1.
    fetchImpl
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(makeResponse(500, { error: 'internal', message: 'oops' }))
    const first = await client.getFleet()
    expect(first.ok).toBe(false)
    expect(client.getBreakerState()).toBe('closed')

    // Call 2: two more 503s, then success. If the streak had carried over
    // from call 1 (the bug), the second 503 here would be counted as the
    // third "consecutive" 503 and would open the breaker immediately,
    // never reaching the success response queued after it.
    fetchImpl
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(makeResponse(200, [SAMPLE_TRUCK]))
    const second = await client.getFleet()
    expect(second).toEqual({ ok: true, data: [SAMPLE_TRUCK] })
    expect(client.getBreakerState()).toBe('closed') // never opened — the streak restarted at 0
    expect(fetchImpl).toHaveBeenCalledTimes(5) // all five queued responses were actually consumed
  })

  it('forceNextProbe(): makes the very next getFleet() call probe immediately, bypassing the schedule', async () => {
    let currentTime = 0
    const now = () => currentTime
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl, now, setTimeoutImpl: immediateSetTimeout })

    await client.getFleet()
    expect(client.getBreakerState()).toBe('open')

    // No time has passed at all — a normal getFleet() would short-circuit
    // locally with no network call.
    const shortCircuited = await client.getFleet()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(shortCircuited.ok).toBe(false)

    client.forceNextProbe()
    fetchImpl.mockResolvedValueOnce(makeResponse(200, [SAMPLE_TRUCK]))
    const forced = await client.getFleet()
    expect(fetchImpl).toHaveBeenCalledTimes(4) // the forced probe actually hit the network
    expect(forced).toEqual({ ok: true, data: [SAMPLE_TRUCK] })
    expect(client.getBreakerState()).toBe('closed')
  })

  it('GET /api/fleet is not a mutation — no X-Dispatcher-Id header, and it is never refused for being unregistered', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, [SAMPLE_TRUCK]))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl })

    const result = await client.getFleet()
    expect(result).toEqual({ ok: true, data: [SAMPLE_TRUCK] })
    expect(fetchImpl).toHaveBeenCalledWith('/api/fleet')
  })
})

describe('api-client — GET /api/routes (story 7, no breaker wrapping)', () => {
  it('is not a mutation — no X-Dispatcher-Id header, never refused for being unregistered', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, [SAMPLE_ROUTE]))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl })

    const result = await client.getRoutes()
    expect(result).toEqual({ ok: true, data: [SAMPLE_ROUTE] })
    expect(fetchImpl).toHaveBeenCalledWith('/api/routes')
    const init = fetchImpl.mock.calls[0]![1] as RequestInit | undefined
    expect(init?.headers).toBeUndefined()
  })

  it('a 503 maps to {kind: "retryable"} — a single attempt, no auto-retry loop (unlike getFleet)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(make503(5))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl })

    const result = await client.getRoutes()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: false, failure: { kind: 'retryable', retryAfterSeconds: 5 } })
  })

  it('never opens or interacts with the getFleet circuit breaker', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
      .mockResolvedValueOnce(make503(3))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl })

    await client.getRoutes()
    await client.getRoutes()
    await client.getRoutes()
    expect(fetchImpl).toHaveBeenCalledTimes(3) // each call actually hit the network — no breaker short-circuit
    expect(client.getBreakerState()).toBe('closed')
  })

  it('a non-503 failure status maps to {kind: "error", body}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(500, { error: 'internal', message: 'oops' }))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl })

    const result = await client.getRoutes()
    expect(result).toEqual({ ok: false, failure: { kind: 'error', body: { error: 'internal', message: 'oops' } } })
  })

  it('a malformed response body degrades to a safe error result rather than throwing', async () => {
    const badJson = { status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new Error('boom') } }
    const fetchImpl = vi.fn().mockResolvedValue(badJson as unknown as Response)
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl })

    const result = await client.getRoutes()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('error')
  })

  it('a thrown fetch error (network down) never escapes — normalized to {kind: "error"}', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('failed to fetch'))
    const client = createApiClient({ getDispatcherId: () => null, fetchImpl })

    await expect(client.getRoutes()).resolves.toMatchObject({ ok: false, failure: { kind: 'error' } })
  })
})
