// FleetPulse — contract fidelity test (AD-13, CAP-1 success criterion)
//
// Asserts that every shape server.js actually puts on the wire — REST
// bodies, WS messages, the SSE telemetry envelope — matches the
// declarations in src/contract/, by driving a real, ephemeral-port
// instance over real HTTP/WS/SSE (no internal function calls, no schema
// library — hand-rolled expected-key-set + typeof/range assertions,
// mirroring shared/constants.test.js's own pattern from story 1.1).
//
// Deterministic quirk triggers exist only under /api/dev/*, and this file
// is the one sanctioned exception to "nothing under src/ references
// /api/dev/*" (AD-11) — it lives at the repo root, sharing server.js's own
// TS project (tsconfig.node.json) rather than the app project, so importing
// server.js never crosses a DOM/node project boundary.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { startServer } from './server.js'
import { SERVER_PARAMS } from './shared/constants.js'

// Response bodies are genuinely arbitrary JSON from this test's point of
// view (the whole point of this file is asserting their shape at runtime,
// not trusting a static type) — `any` here is deliberate, not sloppy.
/** @param {Response} res @returns {Promise<any>} */
async function readJson(res) {
  return res.json()
}

// ---- Section: hand-rolled shape assertions (no schema library) -----------

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} expectedKeys
 * @param {string} label
 */
function assertExactKeys(obj, expectedKeys, label) {
  expect(Object.keys(obj).sort(), `${label} keys`).toEqual([...expectedKeys].sort())
}

/**
 * @param {Record<string, unknown>} obj
 * @param {Record<string, 'string'|'number'|'boolean'>} typeMap
 * @param {string} label
 */
function assertTypes(obj, typeMap, label) {
  for (const [field, expected] of Object.entries(typeMap)) {
    expect(typeof obj[field], `${label}.${field} should be ${expected}`).toBe(expected)
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertNullOrString(value, label) {
  expect(value === null || typeof value === 'string', `${label} should be null or a string`).toBe(true)
}

// ---- Section: expected key sets, mirroring src/contract/*.ts verbatim ----

const TRUCK_KEYS = ['truckId', 'status', 'lat', 'lng', 'speed', 'fuel', 'engineTemp', 'mileage', 'timestamp', 'routeId']
const ROUTE_ACTOR_KEYS = ['dispatcherId', 'name']
const ROUTE_KEYS = [
  'routeId',
  'truckId',
  'status',
  'version',
  'destination',
  'createdBy',
  'createdAt',
  'updatedAt',
  'updatedBy',
]
const TELEMETRY_READING_KEYS = ['truckId', 'timestamp', 'lat', 'lng', 'speed', 'fuel', 'engineTemp', 'mileage']
const TELEMETRY_BATCH_KEYS = ['truckId', 'readings']
const CONFLICT_BODY_KEYS = ['error', 'message', 'conflictingDispatcher', 'currentRoute']
const TRUCK_ALERT_KEYS = ['truckId', 'message', 'dispatcherId', 'dispatcherName', 'timestamp']
const API_ERROR_KEYS = ['error', 'message']

/** @param {Record<string, unknown>} truck */
function assertTruckShape(truck) {
  assertExactKeys(truck, TRUCK_KEYS, 'Truck')
  assertTypes(
    truck,
    { truckId: 'string', status: 'string', lat: 'number', lng: 'number', speed: 'number', fuel: 'number', engineTemp: 'number', mileage: 'number', timestamp: 'number' },
    'Truck',
  )
  expect(['active', 'idle', 'maintenance'], 'Truck.status').toContain(truck.status)
  assertNullOrString(truck.routeId, 'Truck.routeId')
}

/** @param {Record<string, unknown>} actor */
function assertRouteActorShape(actor) {
  assertExactKeys(actor, ROUTE_ACTOR_KEYS, 'RouteActor')
  assertTypes(actor, { dispatcherId: 'string', name: 'string' }, 'RouteActor')
}

/** @param {Record<string, unknown>} route */
function assertRouteShape(route) {
  assertExactKeys(route, ROUTE_KEYS, 'Route')
  assertTypes(
    route,
    { routeId: 'string', truckId: 'string', status: 'string', version: 'number', destination: 'string', createdAt: 'number', updatedAt: 'number' },
    'Route',
  )
  expect(['assigned', 'in-progress', 'completed', 'cancelled'], 'Route.status').toContain(route.status)
  assertRouteActorShape(/** @type {Record<string, unknown>} */ (route.createdBy))
  assertRouteActorShape(/** @type {Record<string, unknown>} */ (route.updatedBy))
}

/** @param {Record<string, unknown>} reading */
function assertTelemetryReadingShape(reading) {
  assertExactKeys(reading, TELEMETRY_READING_KEYS, 'TelemetryReading')
  assertTypes(
    reading,
    { truckId: 'string', timestamp: 'number', lat: 'number', lng: 'number', speed: 'number', fuel: 'number', engineTemp: 'number', mileage: 'number' },
    'TelemetryReading',
  )
}

/** @param {Record<string, unknown>} conflict */
function assertConflictBodyShape(conflict) {
  assertExactKeys(conflict, CONFLICT_BODY_KEYS, 'ConflictErrorBody')
  expect(conflict.error).toBe('version_conflict')
  expect(typeof conflict.message).toBe('string')
  assertRouteActorShape(/** @type {Record<string, unknown>} */ (conflict.conflictingDispatcher))
  assertRouteShape(/** @type {Record<string, unknown>} */ (conflict.currentRoute))
}

// ---- Section: WS test helpers ---------------------------------------------

/** @param {import('ws').WebSocket} ws @returns {any[]} */
function createMessageQueue(ws) {
  /** @type {any[]} */
  const messages = []
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()))
    } catch {
      // ignore malformed frames — not expected from this server
    }
  })
  return messages
}

/**
 * @param {any[]} queue
 * @param {(msg: any) => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(queue, predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = queue.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a matching WS message`)
}

/**
 * Polls an async condition until it's true or the timeout elapses. Used to
 * verify a *behavioral* effect (not just the dev-trigger ack) for quirks
 * whose window only takes effect on the simulator's next tick — forcing a
 * quirk's window open doesn't itself emit a reading; `tick()` does.
 * @param {() => Promise<boolean>} check
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitUntil(check, timeoutMs = SERVER_PARAMS.TELEMETRY_TICK_MS + 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/** @param {string} url @param {string} name */
async function connectDispatcher(url, name) {
  const ws = new WebSocket(url)
  const queue = createMessageQueue(ws)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ type: 'register_dispatcher', name }))
  const registered = await waitFor(queue, (m) => m.type === 'registered')
  return { ws, queue, dispatcherId: /** @type {string} */ (registered.dispatcherId), name: /** @type {string} */ (registered.name) }
}

// ---- Section: REST test helpers --------------------------------------------

/** GET /api/fleet 503s ~15% of the time (FLEET_503_CHANCE); retry past it. @param {string} baseUrl */
async function fetchFleetOk(baseUrl) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${baseUrl}/api/fleet`)
    if (res.status === 200) return res
    if (res.status !== 503) throw new Error(`unexpected GET /api/fleet status ${res.status}`)
  }
  throw new Error('GET /api/fleet returned 503 ten times in a row')
}

/**
 * @param {string} baseUrl @param {string} dispatcherId @param {string} truckId @param {string} [destination]
 * @returns {Promise<any>}
 */
async function createRoute(baseUrl, dispatcherId, truckId, destination = 'Warehouse A') {
  const res = await fetch(`${baseUrl}/api/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dispatcher-Id': dispatcherId },
    body: JSON.stringify({ truckId, destination }),
  })
  expect(res.status).toBe(201)
  return res.json()
}

/** @param {string} baseUrl @param {number} count */
async function readSseEvents(baseUrl, count) {
  const res = await fetch(`${baseUrl}/api/telemetry/stream`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body?.getReader()
  if (!reader) throw new Error('SSE response had no readable body')
  const decoder = new TextDecoder()
  let buffer = ''
  /** @type {any[]} */
  const events = []
  while (events.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)))
      if (events.length >= count) break
    }
  }
  await reader.cancel().catch(() => {})
  return events
}

// ---- Section: suite ---------------------------------------------------------

describe('server.js contract fidelity (AD-13)', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let handle
  /** @type {string} */
  let baseUrl
  /** @type {string} */
  let wsUrl

  beforeAll(async () => {
    handle = await startServer({ port: 0 })
    const address = handle.server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    baseUrl = `http://localhost:${port}`
    wsUrl = `ws://localhost:${port}/ws`
  })

  afterAll(async () => {
    await handle.close()
  })

  describe('GET /api/fleet', () => {
    it('returns FLEET_SIZE Truck-shaped entries', async () => {
      const res = await fetchFleetOk(baseUrl)
      const body = await readJson(res)
      expect(Array.isArray(body)).toBe(true)
      expect(body).toHaveLength(SERVER_PARAMS.FLEET_SIZE)
      for (const truck of body) assertTruckShape(truck)
    })

    it('the forced 503 path (dev quirk 7) carries Retry-After and an ApiErrorBody', async () => {
      await fetch(`${baseUrl}/api/dev/quirk/7`, { method: 'POST' })
      const res = await fetch(`${baseUrl}/api/fleet`)
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe(String(SERVER_PARAMS.FLEET_503_RETRY_AFTER_S))
      const body = await readJson(res)
      assertExactKeys(body, API_ERROR_KEYS, 'ApiErrorBody')
      expect(body.error).toBe('fleet_unavailable')
    })
  })

  describe('GET /api/fleet/:truckId', () => {
    it('200s a real truck, 404s an unknown one', async () => {
      const okRes = await fetch(`${baseUrl}/api/fleet/truck_1`)
      expect(okRes.status).toBe(200)
      assertTruckShape(await readJson(okRes))

      const missingRes = await fetch(`${baseUrl}/api/fleet/truck_404`)
      expect(missingRes.status).toBe(404)
      assertExactKeys(await readJson(missingRes), API_ERROR_KEYS, 'ApiErrorBody')
    })
  })

  describe('WS presence: register_dispatcher / registered / dispatcher_joined / ping-pong / viewing_truck', () => {
    it('registers, replays existing presence to a new joiner, and broadcasts the join live', async () => {
      const alice = await connectDispatcher(wsUrl, 'Alice')
      assertExactKeys(await waitFor(alice.queue, (m) => m.type === 'registered'), ['type', 'dispatcherId', 'name'], 'RegisteredMessage')

      // The system dispatcher (AD-12) is always present, so a fresh joiner
      // is replayed a dispatcher_joined for it even with no other humans online.
      await waitFor(alice.queue, (m) => m.type === 'dispatcher_joined' && m.dispatcherId === 'dispatcher_system')

      alice.ws.send(JSON.stringify({ type: 'viewing_truck', truckId: 'truck_3' }))
      await waitFor(alice.queue, (m) => m.type === 'dispatcher_viewing' && m.dispatcherId === alice.dispatcherId && m.truckId === 'truck_3')

      const bob = await connectDispatcher(wsUrl, 'Bob')
      // Bob is replayed Alice's join and her current viewing target.
      const replayedJoin = await waitFor(bob.queue, (m) => m.type === 'dispatcher_joined' && m.dispatcherId === alice.dispatcherId)
      assertExactKeys(replayedJoin, ['type', 'dispatcherId', 'name'], 'DispatcherJoinedMessage')
      const replayedViewing = await waitFor(bob.queue, (m) => m.type === 'dispatcher_viewing' && m.dispatcherId === alice.dispatcherId)
      assertExactKeys(replayedViewing, ['type', 'dispatcherId', 'truckId'], 'DispatcherViewingMessage')
      expect(replayedViewing.truckId).toBe('truck_3')

      // Alice sees Bob's join live (broadcast, not replay).
      await waitFor(alice.queue, (m) => m.type === 'dispatcher_joined' && m.dispatcherId === bob.dispatcherId)

      // viewing_truck accepts null and the clear is broadcast (FR-18).
      bob.ws.send(JSON.stringify({ type: 'viewing_truck', truckId: null }))
      const cleared = await waitFor(bob.queue, (m) => m.type === 'dispatcher_viewing' && m.dispatcherId === bob.dispatcherId)
      expect(cleared.truckId).toBeNull()

      bob.ws.send(JSON.stringify({ type: 'ping' }))
      const pong = await waitFor(bob.queue, (m) => m.type === 'pong')
      assertExactKeys(pong, ['type'], 'PongMessage')

      bob.ws.close()
      alice.ws.close()
    })

    it(
      'a disconnect broadcasts dispatcher_left (immediately, or after the ghost delay — quirk #6)',
      async () => {
        const watcher = await connectDispatcher(wsUrl, 'Watcher')
        const leaving = await connectDispatcher(wsUrl, 'Leaving')
        leaving.ws.close()
        const left = await waitFor(
          watcher.queue,
          (m) => m.type === 'dispatcher_left' && m.dispatcherId === leaving.dispatcherId,
          SERVER_PARAMS.GHOST_DISCONNECT_DELAY_MS + 2000,
        )
        assertExactKeys(left, ['type', 'dispatcherId'], 'DispatcherLeftMessage')
        watcher.ws.close()
      },
      // The 20% ghost-disconnect chance (quirk #6) can delay this by up to
      // GHOST_DISCONNECT_DELAY_MS — the waitFor() call above already
      // allows for that, but Vitest's own default 5000ms test timeout
      // would still kill the test first without this override.
      SERVER_PARAMS.GHOST_DISCONNECT_DELAY_MS + 5_000,
    )
  })

  describe('REST: route mutations', () => {
    it('POST /api/routes without X-Dispatcher-Id is refused (400) — never processed anonymously', async () => {
      const res = await fetch(`${baseUrl}/api/routes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ truckId: 'truck_1', destination: 'Depot' }),
      })
      expect(res.status).toBe(400)
      assertExactKeys(await readJson(res), API_ERROR_KEYS, 'ApiErrorBody')
    })

    it('POST /api/routes creates a version-1 route and broadcasts route_assigned to all (originator included)', async () => {
      const dispatcher = await connectDispatcher(wsUrl, 'Carol')
      const route = await createRoute(baseUrl, dispatcher.dispatcherId, 'truck_2')
      assertRouteShape(route)
      expect(route.version).toBe(1)

      const msg = await waitFor(dispatcher.queue, (m) => m.type === 'route_assigned' && m.route.routeId === route.routeId)
      assertExactKeys(msg, ['type', 'route'], 'RouteAssignedMessage')
      assertRouteShape(msg.route)

      dispatcher.ws.close()
    })

    it('a stale If-Match 409s through the shared conflict shape (quirk #4)', async () => {
      const dispatcher = await connectDispatcher(wsUrl, 'Dave')
      const route = await createRoute(baseUrl, dispatcher.dispatcherId, 'truck_3')

      const res = await fetch(`${baseUrl}/api/routes/${route.routeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Dispatcher-Id': dispatcher.dispatcherId, 'If-Match': '999' },
        body: JSON.stringify({ status: 'in-progress' }),
      })
      expect(res.status).toBe(409)
      assertConflictBodyShape(await readJson(res))

      dispatcher.ws.close()
    })

    it('a correct If-Match transitions the route and broadcasts route_updated', async () => {
      const dispatcher = await connectDispatcher(wsUrl, 'Erin')
      const route = await createRoute(baseUrl, dispatcher.dispatcherId, 'truck_4')

      const res = await fetch(`${baseUrl}/api/routes/${route.routeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Dispatcher-Id': dispatcher.dispatcherId, 'If-Match': String(route.version) },
        body: JSON.stringify({ status: 'in-progress' }),
      })
      expect(res.status).toBe(200)
      const updated = await readJson(res)
      assertRouteShape(updated)
      expect(updated.status).toBe('in-progress')
      expect(updated.version).toBe(route.version + 1)

      const msg = await waitFor(dispatcher.queue, (m) => m.type === 'route_updated' && m.route.routeId === route.routeId)
      assertExactKeys(msg, ['type', 'route'], 'RouteUpdatedMessage')

      dispatcher.ws.close()
    })

    it('PUT reassign moves the route to a different truck and broadcasts route_reassigned', async () => {
      const dispatcher = await connectDispatcher(wsUrl, 'Frank')
      const route = await createRoute(baseUrl, dispatcher.dispatcherId, 'truck_5')

      const res = await fetch(`${baseUrl}/api/routes/${route.routeId}/reassign`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Dispatcher-Id': dispatcher.dispatcherId, 'If-Match': String(route.version) },
        body: JSON.stringify({ truckId: 'truck_6' }),
      })
      expect(res.status).toBe(200)
      const reassigned = await readJson(res)
      assertRouteShape(reassigned)
      expect(reassigned.truckId).toBe('truck_6')

      const msg = await waitFor(dispatcher.queue, (m) => m.type === 'route_reassigned' && m.route.routeId === route.routeId)
      assertExactKeys(msg, ['type', 'route'], 'RouteReassignedMessage')

      dispatcher.ws.close()
    })

    it('a mid-processing reassignment (quirk #8, the real system dispatcher) 409s a PATCH that was valid when sent', async () => {
      // Reset first so the system dispatcher's chaos reassignment has
      // exactly one candidate route to act on — this test's own.
      await fetch(`${baseUrl}/api/reset`, { method: 'POST' })
      const dispatcher = await connectDispatcher(wsUrl, 'Grace')
      const route = await createRoute(baseUrl, dispatcher.dispatcherId, 'truck_1')

      const patchPromise = fetch(`${baseUrl}/api/routes/${route.routeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Dispatcher-Id': dispatcher.dispatcherId, 'If-Match': String(route.version) },
        body: JSON.stringify({ status: 'in-progress' }),
      })
      // Fires while the PATCH above is still inside its artificial
      // processing delay (ROUTE_MUTATION_PROCESSING_DELAY_MS).
      const quirkRes = await fetch(`${baseUrl}/api/dev/quirk/8`, { method: 'POST' })
      expect((await readJson(quirkRes)).fired).toBe(true)

      const patchRes = await patchPromise
      expect(patchRes.status).toBe(409)
      const conflict = await readJson(patchRes)
      assertConflictBodyShape(conflict)
      expect(conflict.conflictingDispatcher.dispatcherId).toBe('dispatcher_system')

      dispatcher.ws.close()
    })
  })

  describe('POST /api/fleet/:truckId/alert', () => {
    it('broadcasts truck_alert to all dispatchers, sender included (FR-32)', async () => {
      const dispatcher = await connectDispatcher(wsUrl, 'Heidi')
      const res = await fetch(`${baseUrl}/api/fleet/truck_1/alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dispatcher-Id': dispatcher.dispatcherId },
        body: JSON.stringify({ message: 'Low bridge ahead' }),
      })
      expect(res.status).toBe(201)
      const body = await readJson(res)
      assertExactKeys(body, TRUCK_ALERT_KEYS, 'TruckAlert')

      const msg = await waitFor(dispatcher.queue, (m) => m.type === 'truck_alert')
      assertExactKeys(msg, ['type', ...TRUCK_ALERT_KEYS], 'TruckAlertMessage')
      expect(msg.message).toBe('Low bridge ahead')

      dispatcher.ws.close()
    })
  })

  describe('GET /api/telemetry/stream (SSE)', () => {
    it('emits TelemetryBatch-shaped frames for real fleet trucks', async () => {
      const events = await readSseEvents(baseUrl, 3)
      expect(events.length).toBeGreaterThanOrEqual(3)
      for (const batch of events) {
        assertExactKeys(batch, TELEMETRY_BATCH_KEYS, 'TelemetryBatch')
        expect(typeof batch.truckId).toBe('string')
        expect(Array.isArray(batch.readings)).toBe(true)
        expect(batch.readings.length).toBeGreaterThanOrEqual(1)
        for (const reading of batch.readings) assertTelemetryReadingShape(reading)
      }
    }, 10_000)
  })

  describe('GET /api/telemetry/history/:truckId', () => {
    it('returns a bounded, TelemetryReading-shaped history after a forced GPS batch (quirk #1)', async () => {
      const fireRes = await fetch(`${baseUrl}/api/dev/quirk/1`, { method: 'POST' })
      const fired = await readJson(fireRes)
      expect(fired.fired).toBe(true)

      const res = await fetch(`${baseUrl}/api/telemetry/history/${fired.truckId}?limit=5`)
      expect(res.status).toBe(200)
      const body = await readJson(res)
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBeLessThanOrEqual(5)
      expect(body.length).toBeGreaterThan(0)
      for (const reading of body) assertTelemetryReadingShape(reading)

      const missing = await fetch(`${baseUrl}/api/telemetry/history/truck_404`)
      expect(missing.status).toBe(404)
    })
  })

  describe('POST /api/reset', () => {
    it('acks, broadcasts fleet_reset, then re-announces surviving presence (AD-17)', async () => {
      const dispatcher = await connectDispatcher(wsUrl, 'Ivan')
      const res = await fetch(`${baseUrl}/api/reset`, { method: 'POST' })
      expect(res.status).toBe(200)
      assertExactKeys(await readJson(res), ['reset'], 'ResetAckBody')

      await waitFor(dispatcher.queue, (m) => m.type === 'fleet_reset')
      // Presence survives the reset and is re-announced (AD-17) — both the
      // permanent system dispatcher and Ivan himself.
      await waitFor(dispatcher.queue, (m) => m.type === 'dispatcher_joined' && m.dispatcherId === 'dispatcher_system')
      await waitFor(dispatcher.queue, (m) => m.type === 'dispatcher_joined' && m.dispatcherId === dispatcher.dispatcherId)

      dispatcher.ws.close()
    })
  })

  describe('POST /api/dev/quirk/:id', () => {
    it('fires each of quirks 1-8 and 404s an unknown id', async () => {
      // Reset first so quirks #4/#8 (system-dispatcher reassignment) have
      // exactly one candidate route, regardless of what earlier tests left
      // behind; then guarantee a connected (non-system) dispatcher for
      // quirk #6 and a non-terminal route for #4/#8.
      await fetch(`${baseUrl}/api/reset`, { method: 'POST' })
      const dispatcher = await connectDispatcher(wsUrl, 'Judy')
      await createRoute(baseUrl, dispatcher.dispatcherId, 'truck_8')

      // Quirks whose contract shape and effect are already exercised
      // elsewhere in this file (#1 via the history test, #4/#7/#8 via
      // their own dedicated route/fleet tests) — here just the generic ack
      // shape + fired:true.
      for (const id of [1, 4, 7, 8]) {
        const res = await fetch(`${baseUrl}/api/dev/quirk/${id}`, { method: 'POST' })
        expect(res.status, `quirk ${id} status`).toBe(200)
        const body = await readJson(res)
        expect(body.quirkId, `quirk ${id} quirkId`).toBe(id)
        expect(typeof body.fired, `quirk ${id} fired`).toBe('boolean')
        expect(body.fired, `quirk ${id} should fire given a connected dispatcher + non-terminal route`).toBe(true)
      }

      // Quirk #2 (fuel glitch): matrix says "Fuel reads 0% for
      // FUEL_FALSE_ZERO_GLITCH_MIN/MAX_MS, then recovers". Firing only
      // opens the glitch window on the truck (forceFuelGlitchFor) — the
      // truck's public fuel value is only refreshed on the simulator's
      // *next* tick (tick() -> resolveReportedFuel -> recordReading), so
      // poll GET /api/fleet/:truckId until it actually reads 0%.
      const fuelFireRes = await fetch(`${baseUrl}/api/dev/quirk/2`, { method: 'POST' })
      expect(fuelFireRes.status).toBe(200)
      const fuelFired = await readJson(fuelFireRes)
      expect(fuelFired.fired).toBe(true)
      const sawZeroFuel = await waitUntil(async () => {
        const truck = await readJson(await fetch(`${baseUrl}/api/fleet/${fuelFired.truckId}`))
        return truck.fuel === 0
      })
      expect(sawZeroFuel, `truck ${fuelFired.truckId} should read 0% fuel on the next tick after quirk #2 fires`).toBe(
        true,
      )

      // Quirk #3 (stuck speed): matrix says "999 km/h emitted for
      // STUCK_SPEED_DURATION_MIN/MAX_MS". Always STUCK_SPEED_TRUCK_ID
      // (truck_7); same next-tick caveat as #2 applies.
      const speedFireRes = await fetch(`${baseUrl}/api/dev/quirk/3`, { method: 'POST' })
      expect(speedFireRes.status).toBe(200)
      const speedFired = await readJson(speedFireRes)
      expect(speedFired.fired).toBe(true)
      expect(speedFired.truckId).toBe(SERVER_PARAMS.STUCK_SPEED_TRUCK_ID)
      const sawStuckSpeed = await waitUntil(async () => {
        const truck = await readJson(await fetch(`${baseUrl}/api/fleet/${speedFired.truckId}`))
        return truck.speed === SERVER_PARAMS.STUCK_SPEED_KMH
      })
      expect(
        sawStuckSpeed,
        `${SERVER_PARAMS.STUCK_SPEED_TRUCK_ID} should read ${SERVER_PARAMS.STUCK_SPEED_KMH} km/h on the next tick after quirk #3 fires`,
      ).toBe(true)

      // Quirk #5 (out-of-order SSE): matrix says "A tick emits with an
      // older timestamp than the truck's previous emission". Unlike #2/#3,
      // forceOutOfOrderFor records immediately — no tick wait needed — but
      // it targets a random truck and draws a fresh random skew
      // (OUT_OF_ORDER_MAX_SKEW_MS) each call, so a single firing isn't
      // guaranteed to land older than *that specific* previous entry
      // (skew and the age of the prior tick are comparable magnitudes).
      // Retry a handful of times and check the truck's own last two
      // history entries for a real regression.
      let sawTimestampRegression = false
      for (let attempt = 0; attempt < 12 && !sawTimestampRegression; attempt++) {
        const orderFireRes = await fetch(`${baseUrl}/api/dev/quirk/5`, { method: 'POST' })
        expect(orderFireRes.status).toBe(200)
        const orderFired = await readJson(orderFireRes)
        expect(orderFired.fired).toBe(true)
        const history = await readJson(await fetch(`${baseUrl}/api/telemetry/history/${orderFired.truckId}?limit=2`))
        if (history.length === 2 && history[1].timestamp < history[0].timestamp) {
          sawTimestampRegression = true

          // The older reading backfills history (just confirmed above) but
          // must never regress the truck's *live* snapshot — recordReading
          // always keeps GET /api/fleet/:truckId on the batch/tick's true
          // newest reading, never an artifact of which one arrived last.
          const liveTruck = await readJson(await fetch(`${baseUrl}/api/fleet/${orderFired.truckId}`))
          expect(
            liveTruck.timestamp,
            `GET /api/fleet/${orderFired.truckId} should not regress behind the newer of the truck's last two recorded readings`,
          ).toBeGreaterThanOrEqual(history[0].timestamp)
          expect(
            liveTruck.timestamp,
            `GET /api/fleet/${orderFired.truckId} should not show the older out-of-order reading's own (regressed) timestamp`,
          ).not.toBe(history[1].timestamp)
        }
      }
      expect(
        sawTimestampRegression,
        "quirk #5 should eventually emit a reading older than the truck's immediately preceding one",
      ).toBe(true)

      // Quirk #6 (ghost disconnect) forcibly closes the dispatcher socket
      // used above — fire it last so the earlier assertions still had a
      // live socket to work with.
      const ghostRes = await fetch(`${baseUrl}/api/dev/quirk/6`, { method: 'POST' })
      expect(ghostRes.status).toBe(200)
      const ghostBody = await readJson(ghostRes)
      expect(ghostBody.quirkId).toBe(6)
      expect(typeof ghostBody.fired).toBe('boolean')

      const unknownRes = await fetch(`${baseUrl}/api/dev/quirk/99`, { method: 'POST' })
      expect(unknownRes.status).toBe(404)
      assertExactKeys(await readJson(unknownRes), API_ERROR_KEYS, 'ApiErrorBody')
    }, 15_000)
  })
})

// A separate, self-contained suite (its own instance, its own
// beforeAll/afterAll) — deliberately outside the main describe above so it
// never runs concurrently with the shared instance's own background tick.
// Math.random is stubbed process-wide for its duration; isolating it to a
// suite that starts only after the main one has fully torn down (Vitest
// runs top-level describes in file order) keeps that stub from perturbing
// any other test's randomness.
describe('quirk scheduler self-fire (unattended — no /api/dev/* bypass)', () => {
  it(
    "the real Math.random() < *_CHANCE gates inside tick()/resolveReportedFuel/resolveReportedSpeed fire on their own, not only via the dev-trigger bypass",
    async () => {
      // Math.random() === 0 makes every `Math.random() < *_CHANCE` gate in
      // the simulator true, so the very first unforced tick (fires
      // TELEMETRY_TICK_MS after the interval starts) should trip stuck
      // speed (#3, always truck_7) and fuel glitch (#2, any truck) without
      // this test ever calling POST /api/dev/quirk/*.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
      /** @type {Awaited<ReturnType<typeof startServer>> | undefined} */
      let soloHandle
      try {
        soloHandle = await startServer({ port: 0 })
        const address = soloHandle.server.address()
        const port = address && typeof address === 'object' ? address.port : 0
        const soloBaseUrl = `http://localhost:${port}`

        await new Promise((resolve) => setTimeout(resolve, SERVER_PARAMS.TELEMETRY_TICK_MS + 500))
        randomSpy.mockRestore()

        const stuckTruck = await readJson(await fetch(`${soloBaseUrl}/api/fleet/${SERVER_PARAMS.STUCK_SPEED_TRUCK_ID}`))
        expect(stuckTruck.speed, 'truck_7 should self-fire quirk #3 on the real, unforced tick').toBe(
          SERVER_PARAMS.STUCK_SPEED_KMH,
        )

        const fleetRes = await fetchFleetOk(soloBaseUrl)
        const fleet = await readJson(fleetRes)
        const glitched = fleet.find((/** @type {any} */ t) => t.fuel === 0)
        expect(glitched, 'at least one truck should self-fire quirk #2 (fuel glitch) on the real, unforced tick').toBeTruthy()
      } finally {
        randomSpy.mockRestore()
        if (soloHandle) await soloHandle.close()
      }
    },
    10_000,
  )
})
