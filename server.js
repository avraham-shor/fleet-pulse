// FleetPulse — self-built mock server (AD-11, AD-12, CAP-1)
//
// One Node ESM file, Express + `ws` + node builtins + shared/constants.js
// only. Implements the brief's full REST/WS/SSE contract, a 12-truck 2s
// tick simulator, and a quirk scheduler that self-fires all eight
// intentional failure modes (and can additionally be fired deterministically
// via POST /api/dev/quirk/:id — never the *only* firing path).
//
// Internal composition (sections below, not files, per AD-12):
//   pure helpers & factories -> createFleetPulseInstance() (per-instance
//   state: truck simulator, quirk scheduler/dev triggers, route store,
//   presence registry, SSE broadcaster, WS hub, REST handlers, all closed
//   over one instance's state so two startServer() calls never share
//   state) -> server factory / auto-start.
//
// Do NOT modify this file's public wire behavior without renegotiating the
// brief's contract (AD-11) — see src/contract/ for the declared shapes and
// server.contract.test.js for the fidelity check.

import express from 'express'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { SERVER_PARAMS } from './shared/constants.js'

// ---- Section: local typedefs (documentation + strict checkJs) -----------

/**
 * @typedef {'active'|'idle'|'maintenance'} TruckStatusValue
 * @typedef {'assigned'|'in-progress'|'completed'|'cancelled'} RouteStatusValue
 *
 * @typedef {object} TruckState
 * @property {string} truckId
 * @property {TruckStatusValue} status
 * @property {number} lat
 * @property {number} lng
 * @property {number} speed
 * @property {number} fuel
 * @property {number} engineTemp
 * @property {number} mileage
 * @property {number} timestamp
 * @property {string|null} routeId
 * @property {number} _trueSpeed
 * @property {number} _trueFuel
 * @property {number} _heading
 * @property {number} _fuelGlitchUntil
 * @property {number} _stuckSpeedUntil
 *
 * @typedef {object} RouteActor
 * @property {string} dispatcherId
 * @property {string} name
 *
 * @typedef {object} RouteState
 * @property {string} routeId
 * @property {string} truckId
 * @property {RouteStatusValue} status
 * @property {number} version
 * @property {string} destination
 * @property {RouteActor} createdBy
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {RouteActor} updatedBy
 *
 * @typedef {object} PresenceEntry
 * @property {string} dispatcherId
 * @property {string} name
 * @property {import('ws').WebSocket | null} ws
 * @property {string|null} viewingTruckId
 * @property {number} joinedAt
 *
 * @typedef {object} TelemetryReading
 * @property {string} truckId
 * @property {number} timestamp
 * @property {number} lat
 * @property {number} lng
 * @property {number} speed
 * @property {number} fuel
 * @property {number} engineTemp
 * @property {number} mileage
 *
 * @typedef {object} TelemetryBatch
 * @property {string} truckId
 * @property {TelemetryReading[]} readings
 *
 * @typedef {object} FleetPulseServerHandle
 * @property {import('express').Express} app
 * @property {import('node:http').Server} server
 * @property {import('ws').WebSocketServer} wss
 * @property {() => Promise<void>} close
 */

// ---- Section: generic helpers (pure — no instance state) ------------------

/** @param {number} min @param {number} max @returns {number} */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** @param {number} min @param {number} max @returns {number} */
function randomFloat(min, max) {
  return Math.random() * (max - min) + min
}

/** @param {number} v @param {number} min @param {number} max @returns {number} */
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max)
}

/**
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function pickRandom(arr) {
  return arr[randomInt(0, arr.length - 1)]
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const SYSTEM_DISPATCHER_ID = 'dispatcher_system'
const SYSTEM_DISPATCHER_NAME = 'System'
/** @type {RouteActor} */
const SYSTEM_ACTOR = { dispatcherId: SYSTEM_DISPATCHER_ID, name: SYSTEM_DISPATCHER_NAME }

// Cosmetic simulation flavor only — no client threshold pairs with these
// and no test asserts their specific values, so (unlike the quirk
// probabilities/durations and the port) they stay as ordinary local
// constants rather than shared/constants.js tunables (AD-2 governs values
// both sides must agree on; a bounding box for fake GPS coordinates isn't
// one of them).
const MAP_LAT_MIN = 32.05
const MAP_LAT_MAX = 32.15
const MAP_LNG_MIN = 34.75
const MAP_LNG_MAX = 34.85
const DEFAULT_HISTORY_LIMIT = 50

/** @param {number} index @returns {TruckStatusValue} */
function pickInitialStatus(index) {
  if (index % 5 === 0) return 'maintenance'
  if (index % 3 === 0) return 'idle'
  return 'active'
}

/** @param {TruckStatusValue} status @returns {[number, number]} */
function speedRangeForStatus(status) {
  if (status === 'maintenance') return [0, 0]
  if (status === 'idle') return [0, 8]
  return [15, 90]
}

/** @param {number} index @returns {TruckState} */
function createTruck(index) {
  const truckId = `truck_${index}`
  const status = pickInitialStatus(index)
  const fuel = randomInt(45, 100)
  const now = Date.now()
  return {
    truckId,
    status,
    lat: randomFloat(MAP_LAT_MIN, MAP_LAT_MAX),
    lng: randomFloat(MAP_LNG_MIN, MAP_LNG_MAX),
    speed: 0,
    fuel,
    engineTemp: randomInt(72, 90),
    mileage: randomInt(1_000, 80_000),
    timestamp: now,
    routeId: null,
    _trueSpeed: 0,
    _trueFuel: fuel,
    _heading: randomFloat(0, 360),
    _fuelGlitchUntil: 0,
    _stuckSpeedUntil: 0,
  }
}

/**
 * @returns {{trucks: Map<string, TruckState>, history: Map<string, TelemetryReading[]>, routes: Map<string, RouteState>}}
 */
function createInitialState() {
  /** @type {Map<string, TruckState>} */
  const trucks = new Map()
  /** @type {Map<string, TelemetryReading[]>} */
  const history = new Map()
  for (let i = 1; i <= SERVER_PARAMS.FLEET_SIZE; i++) {
    const truck = createTruck(i)
    trucks.set(truck.truckId, truck)
    history.set(truck.truckId, [])
  }
  /** @type {Map<string, RouteState>} */
  const routes = new Map()
  return { trucks, history, routes }
}

/** @param {TruckState} t */
function toPublicTruck(t) {
  return {
    truckId: t.truckId,
    status: t.status,
    lat: t.lat,
    lng: t.lng,
    speed: t.speed,
    fuel: t.fuel,
    engineTemp: t.engineTemp,
    mileage: t.mileage,
    timestamp: t.timestamp,
    routeId: t.routeId,
  }
}

/** @param {RouteState} r */
function toPublicRoute(r) {
  return {
    routeId: r.routeId,
    truckId: r.truckId,
    status: r.status,
    version: r.version,
    destination: r.destination,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  }
}

/** @param {import('express').Response} res @param {RouteState} route */
function sendConflict(res, route) {
  res.status(409).json({
    error: 'version_conflict',
    message: `Route ${route.routeId} was modified by ${route.updatedBy.name}`,
    conflictingDispatcher: route.updatedBy,
    currentRoute: toPublicRoute(route),
  })
}

// ---- Section: truck simulator internals (pure — operate on a passed truck) -

/**
 * Advances one truck's *true* physical state one tick: speed (bounded by
 * status), position/mileage (from true speed), fuel drain, engine temp.
 * This is the ground truth the sensors read from — quirks below corrupt
 * only what gets *reported*, never this.
 * @param {TruckState} truck
 */
function simulateStep(truck) {
  const [minSpeed, maxSpeed] = speedRangeForStatus(truck.status)
  truck._trueSpeed = clamp(truck._trueSpeed + randomFloat(-12, 12), minSpeed, maxSpeed)

  const headingRad = (truck._heading * Math.PI) / 180
  const distanceKm = (truck._trueSpeed * SERVER_PARAMS.TELEMETRY_TICK_MS) / 3_600_000
  const lngScale = Math.cos((truck.lat * Math.PI) / 180) || 1
  let lat = truck.lat + (distanceKm / 111) * Math.cos(headingRad)
  let lng = truck.lng + (distanceKm / (111 * lngScale)) * Math.sin(headingRad)
  if (lat < MAP_LAT_MIN || lat > MAP_LAT_MAX) {
    truck._heading = (180 - truck._heading + 360) % 360
    lat = clamp(lat, MAP_LAT_MIN, MAP_LAT_MAX)
  }
  if (lng < MAP_LNG_MIN || lng > MAP_LNG_MAX) {
    truck._heading = (360 - truck._heading) % 360
    lng = clamp(lng, MAP_LNG_MIN, MAP_LNG_MAX)
  }
  truck.lat = lat
  truck.lng = lng
  truck.mileage += distanceKm

  truck._trueFuel = clamp(truck._trueFuel - truck._trueSpeed * 0.002, 0, 100)
  if (truck._trueFuel < 8 && Math.random() < 0.3) {
    truck._trueFuel = randomInt(60, 100)
  }

  const targetTemp = 65 + truck._trueSpeed * 0.25
  truck.engineTemp = clamp(truck.engineTemp + (targetTemp - truck.engineTemp) * 0.1 + randomFloat(-1, 1), 55, 115)
}

/**
 * Resolves the *reported* speed for this tick: the stuck-speed quirk (#3,
 * truck_7 only) overrides it to 999 while its window is open.
 * @param {TruckState} truck @param {number} now @returns {number}
 */
function resolveReportedSpeed(truck, now) {
  if (truck._stuckSpeedUntil > now) return SERVER_PARAMS.STUCK_SPEED_KMH
  if (truck.truckId === SERVER_PARAMS.STUCK_SPEED_TRUCK_ID && Math.random() < SERVER_PARAMS.STUCK_SPEED_CHANCE) {
    truck._stuckSpeedUntil =
      now + randomInt(SERVER_PARAMS.STUCK_SPEED_DURATION_MIN_MS, SERVER_PARAMS.STUCK_SPEED_DURATION_MAX_MS)
    return SERVER_PARAMS.STUCK_SPEED_KMH
  }
  return Math.round(truck._trueSpeed)
}

/**
 * Resolves the *reported* fuel for this tick: the fuel-glitch quirk (#2)
 * overrides it to 0 while its window is open.
 * @param {TruckState} truck @param {number} now @returns {number}
 */
function resolveReportedFuel(truck, now) {
  if (truck._fuelGlitchUntil > now) return 0
  if (Math.random() < SERVER_PARAMS.FUEL_GLITCH_CHANCE) {
    truck._fuelGlitchUntil =
      now + randomInt(SERVER_PARAMS.FUEL_FALSE_ZERO_GLITCH_MIN_MS, SERVER_PARAMS.FUEL_FALSE_ZERO_GLITCH_MAX_MS)
    return 0
  }
  return Math.round(truck._trueFuel)
}

/**
 * @param {TruckState} truck @param {number} timestamp @param {number} speed @param {number} fuel
 * @returns {TelemetryReading}
 */
function makeReading(truck, timestamp, speed, fuel) {
  return {
    truckId: truck.truckId,
    timestamp,
    lat: truck.lat,
    lng: truck.lng,
    speed,
    fuel,
    engineTemp: Math.round(truck.engineTemp * 10) / 10,
    mileage: Math.round(truck.mileage * 10) / 10,
  }
}

/**
 * Builds a normal (non-batch) emission: usually one on-time reading; the
 * out-of-order quirk (#5) occasionally skews its timestamp into the past.
 * @param {TruckState} truck @param {number} now @param {number} speed @param {number} fuel
 * @returns {TelemetryBatch}
 */
function buildSingleEmission(truck, now, speed, fuel) {
  let ts = now
  if (Math.random() < SERVER_PARAMS.OUT_OF_ORDER_CHANCE) {
    ts = now - randomInt(1, SERVER_PARAMS.OUT_OF_ORDER_MAX_SKEW_MS)
  }
  return { truckId: truck.truckId, readings: [makeReading(truck, ts, speed, fuel)] }
}

/**
 * Builds a GPS-batch emission (quirk #1): 10-30 readings walking backward
 * from the truck's current position along its heading, timestamps spaced
 * one tick apart ending at `now` — "where the truck was during signal
 * loss," a real (possibly non-monotonic) thin trail rather than one point
 * repeated. `readings[readings.length - 1]` is always the batch's real,
 * current-sensor-value entry (the others carry baseline pre-glitch values)
 * — the occasional intra-batch timestamp swap below is restricted to never
 * touch that last entry, so the batch's true-latest reading never has its
 * real values separated from its own timestamp (review finding, story 1.2).
 * @param {TruckState} truck @param {number} now @param {number} speed @param {number} fuel
 * @returns {TelemetryBatch}
 */
function buildBatchEmission(truck, now, speed, fuel) {
  const size = randomInt(SERVER_PARAMS.GPS_BATCH_SIZE_MIN, SERVER_PARAMS.GPS_BATCH_SIZE_MAX)
  const headingRad = (truck._heading * Math.PI) / 180
  const lngScale = Math.cos((truck.lat * Math.PI) / 180) || 1
  const stepKm = Math.max(truck._trueSpeed, 5) * (SERVER_PARAMS.TELEMETRY_TICK_MS / 3_600_000)
  const dLatStep = (stepKm / 111) * Math.cos(headingRad)
  const dLngStep = (stepKm / (111 * lngScale)) * Math.sin(headingRad)

  /** @type {TelemetryReading[]} */
  const readings = []
  for (let i = size - 1; i >= 0; i--) {
    const isLatest = i === 0
    readings.push({
      truckId: truck.truckId,
      timestamp: now - i * SERVER_PARAMS.TELEMETRY_TICK_MS,
      lat: truck.lat - dLatStep * i,
      lng: truck.lng - dLngStep * i,
      speed: isLatest ? speed : Math.round(truck._trueSpeed),
      fuel: isLatest ? fuel : Math.round(truck._trueFuel),
      engineTemp: Math.round(truck.engineTemp * 10) / 10,
      mileage: Math.round((truck.mileage - stepKm * i) * 10) / 10,
    })
  }
  // Occasionally swap two adjacent readings' timestamps, so a batch itself
  // can carry a non-monotonic entry (quirk #5's ordering concern applies
  // inside a batch too, not only between ticks) — same roll, one constant.
  // The swap range excludes the last index on purpose (see doc comment
  // above): swapping it would relabel the batch's one real-current-values
  // entry with an older timestamp while a baseline entry inherits `now`,
  // corrupting which reading recordReading() treats as the live snapshot.
  if (readings.length > 2 && Math.random() < SERVER_PARAMS.OUT_OF_ORDER_CHANCE) {
    const idx = randomInt(1, readings.length - 2)
    const tmp = readings[idx].timestamp
    readings[idx].timestamp = readings[idx - 1].timestamp
    readings[idx - 1].timestamp = tmp
  }
  return { truckId: truck.truckId, readings }
}

// ---- Section: route store internals (pure — operate on passed values) -----

/** @type {Record<RouteStatusValue, RouteStatusValue[]>} */
const LEGAL_TRANSITIONS = {
  assigned: ['in-progress', 'cancelled'],
  'in-progress': ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

/** @param {RouteStatusValue} from @param {string} to @returns {boolean} */
function isValidTransition(from, to) {
  return LEGAL_TRANSITIONS[from].includes(/** @type {RouteStatusValue} */ (to))
}

/** @param {RouteState} route @param {RouteActor} actor */
function bumpVersion(route, actor) {
  route.version += 1
  route.updatedAt = Date.now()
  route.updatedBy = actor
}

// ---- Section: one FleetPulse instance's stateful internals ----------------
//
// Everything below that touches trucks/routes/history/presence/sockets is
// defined inside this factory, so each startServer() call gets genuinely
// isolated state — module-scope mutable state would otherwise let two
// server instances (e.g. two tests) bleed into each other (review finding,
// story 1.2).

function createFleetPulseInstance() {
  let state = createInitialState()
  let forceNext503 = false

  /** @type {WeakSet<import('ws').WebSocket>} */
  const forcedGhostSockets = new WeakSet()

  /** @type {Map<string, PresenceEntry>} */
  const presence = new Map()
  presence.set(SYSTEM_DISPATCHER_ID, {
    dispatcherId: SYSTEM_DISPATCHER_ID,
    name: SYSTEM_DISPATCHER_NAME,
    ws: null,
    viewingTruckId: null,
    joinedAt: Date.now(),
  })

  /** @type {WeakMap<import('ws').WebSocket, string>} */
  const wsIdentity = new WeakMap()

  /** @type {Set<import('express').Response>} */
  const sseClients = new Set()

  // Ghost-disconnect (quirk #6) delays a dispatcher_left broadcast by
  // GHOST_DISCONNECT_DELAY_MS via setTimeout; tracked here so close() can
  // cancel every pending one instead of letting it fire later against
  // whatever instance happens to exist by then (review finding).
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const pendingGhostTimers = new Set()

  // ---- WS broadcast plumbing (shared by hub + simulator + routes) ----

  /** @param {import('ws').WebSocket} ws @param {object} msg */
  function sendTo(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** @param {object} msg @param {import('ws').WebSocket} [excludeWs] */
  function broadcastWs(msg, excludeWs) {
    const data = JSON.stringify(msg)
    for (const entry of presence.values()) {
      if (!entry.ws || entry.ws === excludeWs) continue
      if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(data)
    }
  }

  /** @param {TelemetryBatch} emission */
  function broadcastTelemetry(emission) {
    const data = `data: ${JSON.stringify(emission)}\n\n`
    for (const res of [...sseClients]) {
      try {
        res.write(data)
      } catch {
        // AD-12: reap on write error — client-abort propagation through the
        // Vite dev proxy is unreliable, so a failed write is itself the signal.
        sseClients.delete(res)
      }
    }
  }

  // ---- truck simulator: recording readings ----

  /**
   * Records every reading into history (arrival order, bounded — NFR-3),
   * then applies *only* the reading with the batch's true maximum
   * timestamp to the truck's public live-state snapshot — a single
   * winner-takes-it selection, not a fold over array/iteration order,
   * so a non-monotonic batch (the intra-batch swap above) can never fool
   * this into applying a stale-valued-but-relabeled entry (review
   * finding, story 1.2). Mirrors the "newest reading timestamp wins"
   * ordering rule the client applies (FR-6) so an out-of-order or
   * backfilled reading never regresses GET /api/fleet's view of "now".
   * @param {TruckState} truck @param {TelemetryReading[]} readings
   */
  function recordReading(truck, readings) {
    const buf = state.history.get(truck.truckId)
    /** @type {TelemetryReading | null} */
    let newest = null
    for (const r of readings) {
      if (buf) {
        buf.push(r)
        if (buf.length > SERVER_PARAMS.TELEMETRY_HISTORY_CAP) buf.shift()
      }
      if (!newest || r.timestamp > newest.timestamp) newest = r
    }
    if (newest && newest.timestamp >= truck.timestamp) {
      truck.lat = newest.lat
      truck.lng = newest.lng
      truck.speed = newest.speed
      truck.fuel = newest.fuel
      truck.engineTemp = newest.engineTemp
      truck.mileage = newest.mileage
      truck.timestamp = newest.timestamp
    }
  }

  // ---- route store: mutation helpers needing live state ----

  /** @param {RouteState} route @param {string} newTruckId */
  function reassignRouteTruck(route, newTruckId) {
    const oldTruck = state.trucks.get(route.truckId)
    if (oldTruck && oldTruck.routeId === route.routeId) oldTruck.routeId = null
    route.truckId = newTruckId
    const newTruck = state.trucks.get(newTruckId)
    if (newTruck) newTruck.routeId = route.routeId
  }

  /**
   * Quirk #8's permanent mechanism (AD-12): the synthetic `system`
   * dispatcher reassigns a random non-terminal route to a different truck
   * — a real reassignment, broadcast normally, never a phantom id. Also
   * the shared self-fire/dev-trigger mechanism for quirk #4
   * (constants.md): the version bump this leaves behind is what turns a
   * stale `If-Match` into a real conflict for whoever reads it next.
   * @returns {boolean}
   */
  function performSystemReassign() {
    const candidates = [...state.routes.values()].filter((r) => r.status === 'assigned' || r.status === 'in-progress')
    if (candidates.length === 0) return false
    const route = pickRandom(candidates)
    const otherTruckIds = [...state.trucks.keys()].filter((id) => id !== route.truckId)
    if (otherTruckIds.length === 0) return false
    reassignRouteTruck(route, pickRandom(otherTruckIds))
    bumpVersion(route, SYSTEM_ACTOR)
    broadcastWs({ type: 'route_reassigned', route: toPublicRoute(route) })
    return true
  }

  /**
   * Shared gate for every version-checked route mutation (PATCH, PUT
   * reassign). Reads `If-Match` once, waits out the artificial processing
   * delay (constants.md), then *re-resolves the route from current state*
   * before comparing versions — if POST /api/reset (or anything else)
   * removed this route from state.routes during the delay, this responds
   * 404 rather than letting a stale in-flight mutation commit against (and
   * broadcast for) a route nothing can reach any more (review finding,
   * story 1.2). Comparing versions only after re-resolving is what makes a
   * stale-at-entry conflict (quirk #4) and a stale-during-processing race
   * (quirk #8) land through the exact same path (AD-11/FR-13), rather than
   * two.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {RouteState} route
   * @param {(currentRoute: RouteState) => void} applyFn
   */
  async function withVersionCheck(req, res, route, applyFn) {
    const ifMatch = req.get('If-Match')
    if (ifMatch === undefined) {
      res.status(400).json({ error: 'missing_if_match', message: 'If-Match header is required' })
      return
    }
    const expectedVersion = Number(ifMatch)
    const routeId = route.routeId
    await sleep(SERVER_PARAMS.ROUTE_MUTATION_PROCESSING_DELAY_MS)
    const currentRoute = state.routes.get(routeId)
    if (!currentRoute) {
      res.status(404).json({ error: 'not_found', message: 'route not found' })
      return
    }
    if (!Number.isFinite(expectedVersion) || expectedVersion !== currentRoute.version) {
      sendConflict(res, currentRoute)
      return
    }
    applyFn(currentRoute)
  }

  // ---- quirk scheduler (self-fire, per tick) + dev triggers ----

  function tick() {
    const now = Date.now()
    for (const truck of state.trucks.values()) {
      simulateStep(truck)
      const speed = resolveReportedSpeed(truck, now)
      const fuel = resolveReportedFuel(truck, now)
      const emission =
        Math.random() < SERVER_PARAMS.GPS_BATCH_CHANCE
          ? buildBatchEmission(truck, now, speed, fuel)
          : buildSingleEmission(truck, now, speed, fuel)
      recordReading(truck, emission.readings)
      broadcastTelemetry(emission)
    }
    if (Math.random() < SERVER_PARAMS.SYSTEM_REASSIGN_CHANCE) performSystemReassign()
  }

  /** @param {string} truckId */
  function forceGpsBatchFor(truckId) {
    const truck = state.trucks.get(truckId)
    if (!truck) return null
    const now = Date.now()
    simulateStep(truck)
    const speed = resolveReportedSpeed(truck, now)
    const fuel = resolveReportedFuel(truck, now)
    const emission = buildBatchEmission(truck, now, speed, fuel)
    recordReading(truck, emission.readings)
    broadcastTelemetry(emission)
    return { truckId, batchSize: emission.readings.length }
  }

  /** @param {string} truckId */
  function forceFuelGlitchFor(truckId) {
    const truck = state.trucks.get(truckId)
    if (!truck) return null
    truck._fuelGlitchUntil =
      Date.now() + randomInt(SERVER_PARAMS.FUEL_FALSE_ZERO_GLITCH_MIN_MS, SERVER_PARAMS.FUEL_FALSE_ZERO_GLITCH_MAX_MS)
    return { truckId }
  }

  function forceStuckSpeed() {
    const truckId = SERVER_PARAMS.STUCK_SPEED_TRUCK_ID
    const truck = state.trucks.get(truckId)
    if (!truck) return null
    truck._stuckSpeedUntil =
      Date.now() + randomInt(SERVER_PARAMS.STUCK_SPEED_DURATION_MIN_MS, SERVER_PARAMS.STUCK_SPEED_DURATION_MAX_MS)
    return { truckId }
  }

  /** @param {string} truckId */
  function forceOutOfOrderFor(truckId) {
    const truck = state.trucks.get(truckId)
    if (!truck) return null
    const now = Date.now()
    simulateStep(truck)
    const speed = resolveReportedSpeed(truck, now)
    const fuel = resolveReportedFuel(truck, now)
    const ts = now - randomInt(1, SERVER_PARAMS.OUT_OF_ORDER_MAX_SKEW_MS)
    const reading = makeReading(truck, ts, speed, fuel)
    recordReading(truck, [reading])
    broadcastTelemetry({ truckId, readings: [reading] })
    return { truckId, timestamp: ts }
  }

  function forceGhostDisconnect() {
    const entry = [...presence.values()].find((e) => e.ws && e.dispatcherId !== SYSTEM_DISPATCHER_ID)
    if (!entry || !entry.ws) return null
    forcedGhostSockets.add(entry.ws)
    entry.ws.close()
    return { dispatcherId: entry.dispatcherId }
  }

  /** @type {Record<number, () => Record<string, unknown>>} */
  const quirkHandlers = {
    1: () => {
      const truck = pickRandom([...state.trucks.values()])
      const result = forceGpsBatchFor(truck.truckId)
      return result ? { fired: true, ...result } : { fired: false }
    },
    2: () => {
      const truck = pickRandom([...state.trucks.values()])
      const result = forceFuelGlitchFor(truck.truckId)
      return result ? { fired: true, ...result } : { fired: false }
    },
    3: () => {
      const result = forceStuckSpeed()
      return result ? { fired: true, ...result } : { fired: false }
    },
    4: () => ({ fired: performSystemReassign() }),
    5: () => {
      const truck = pickRandom([...state.trucks.values()])
      const result = forceOutOfOrderFor(truck.truckId)
      return result ? { fired: true, ...result } : { fired: false }
    },
    6: () => {
      const result = forceGhostDisconnect()
      return result ? { fired: true, ...result } : { fired: false, reason: 'no connected dispatcher' }
    },
    7: () => {
      forceNext503 = true
      return { fired: true, note: 'next GET /api/fleet will return 503' }
    },
    8: () => ({ fired: performSystemReassign() }),
  }

  // ---- presence registry + WS hub ----

  /** @param {import('express').Request} req @param {import('express').Response} res @returns {RouteActor | null} */
  function requireDispatcher(req, res) {
    const id = req.get('X-Dispatcher-Id')
    if (!id) {
      res.status(400).json({ error: 'missing_dispatcher_id', message: 'X-Dispatcher-Id header is required' })
      return null
    }
    // The system dispatcher is a server-internal actor (quirks #4/#8,
    // AD-12), permanently present so its route events resolve a display
    // name — but it must never be impersonable by an external REST caller
    // just because it's always in the presence registry (review finding).
    if (id === SYSTEM_DISPATCHER_ID) {
      res
        .status(400)
        .json({ error: 'forbidden_dispatcher_id', message: 'the system dispatcher identity cannot be used by REST callers' })
      return null
    }
    const entry = presence.get(id)
    if (!entry) {
      res.status(400).json({ error: 'unknown_dispatcher', message: 'X-Dispatcher-Id does not match a registered dispatcher' })
      return null
    }
    return { dispatcherId: entry.dispatcherId, name: entry.name }
  }

  /** @param {import('ws').WebSocket} ws @param {any} msg */
  function handleRegister(ws, msg) {
    const existingId = wsIdentity.get(ws)
    if (existingId) {
      // A second register_dispatcher on an already-registered socket would
      // otherwise leak the first presence entry forever (nothing else ever
      // removes it, since close() only clears the *current* wsIdentity
      // mapping) — retire the old identity first instead (FR-19: every
      // registration must eventually be cleared) (review finding).
      presence.delete(existingId)
      wsIdentity.delete(ws)
      broadcastWs({ type: 'dispatcher_left', dispatcherId: existingId })
    }
    const name = typeof msg.name === 'string' && msg.name.trim() !== '' ? msg.name.trim() : 'Anonymous'
    const dispatcherId = randomUUID()
    /** @type {PresenceEntry} */
    const entry = { dispatcherId, name, ws, viewingTruckId: null, joinedAt: Date.now() }
    presence.set(dispatcherId, entry)
    wsIdentity.set(ws, dispatcherId)

    sendTo(ws, { type: 'registered', dispatcherId, name })

    // The brief's protocol has no bulk presence-snapshot message type, so a
    // newly-registering socket learns about everyone already present by
    // replaying the same per-dispatcher event types, targeted only at it
    // (story 1.2 design choice — see DECISIONS.md).
    for (const other of presence.values()) {
      if (other.dispatcherId === dispatcherId) continue
      sendTo(ws, { type: 'dispatcher_joined', dispatcherId: other.dispatcherId, name: other.name })
      if (other.viewingTruckId) {
        sendTo(ws, { type: 'dispatcher_viewing', dispatcherId: other.dispatcherId, truckId: other.viewingTruckId })
      }
    }

    broadcastWs({ type: 'dispatcher_joined', dispatcherId, name }, ws)
  }

  /** @param {import('ws').WebSocket} ws @param {any} msg */
  function handleViewing(ws, msg) {
    const dispatcherId = wsIdentity.get(ws)
    if (!dispatcherId) return
    const entry = presence.get(dispatcherId)
    if (!entry) return
    const truckId = msg.truckId === null || typeof msg.truckId === 'string' ? msg.truckId : null
    entry.viewingTruckId = truckId
    broadcastWs({ type: 'dispatcher_viewing', dispatcherId, truckId })
  }

  /** @param {import('ws').WebSocket} ws @param {any} msg */
  function handleWsMessage(ws, msg) {
    if (!msg || typeof msg.type !== 'string') return
    if (msg.type === 'register_dispatcher') {
      handleRegister(ws, msg)
      return
    }
    if (msg.type === 'ping') {
      sendTo(ws, { type: 'pong' })
      return
    }
    if (msg.type === 'viewing_truck') {
      handleViewing(ws, msg)
      return
    }
    // Unknown client message types are dropped safely, mirroring the client
    // side's own tolerance (AD-8) applied defensively here too.
  }

  /** @param {import('ws').WebSocket} ws */
  function handleWsClose(ws) {
    const dispatcherId = wsIdentity.get(ws)
    if (!dispatcherId) return
    wsIdentity.delete(ws)
    presence.delete(dispatcherId)
    const isGhost = forcedGhostSockets.has(ws) || Math.random() < SERVER_PARAMS.GHOST_DISCONNECT_CHANCE
    forcedGhostSockets.delete(ws)
    const emitLeft = () => broadcastWs({ type: 'dispatcher_left', dispatcherId })
    if (isGhost) {
      /** @type {ReturnType<typeof setTimeout>} */
      let timer
      timer = setTimeout(() => {
        pendingGhostTimers.delete(timer)
        emitLeft()
      }, SERVER_PARAMS.GHOST_DISCONNECT_DELAY_MS)
      pendingGhostTimers.add(timer)
    } else {
      emitLeft()
    }
  }

  /** @param {import('node:http').Server} httpServer */
  function attachWebSocketHub(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        /** @type {any} */
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        handleWsMessage(ws, msg)
      })
      ws.on('close', () => handleWsClose(ws))
      // A socket-level error (e.g. an abrupt reset) is not itself
      // actionable here — the 'close' event every socket eventually gets
      // drives cleanup. Node's EventEmitter throws on an unhandled 'error'
      // event, which would otherwise let one client's socket error crash
      // the process for every connected dispatcher (review finding).
      ws.on('error', () => {})
    })
    return wss
  }

  // ---- REST handlers ----

  function createApp() {
    const app = express()
    app.use(express.json())

    app.get('/api/fleet', (_req, res) => {
      if (forceNext503 || Math.random() < SERVER_PARAMS.FLEET_503_CHANCE) {
        forceNext503 = false
        res
          .status(503)
          .set('Retry-After', String(SERVER_PARAMS.FLEET_503_RETRY_AFTER_S))
          .json({ error: 'fleet_unavailable', message: 'fleet service temporarily unavailable' })
        return
      }
      res.status(200).json([...state.trucks.values()].map(toPublicTruck))
    })

    app.get('/api/fleet/:truckId', (req, res) => {
      const truck = state.trucks.get(req.params.truckId)
      if (!truck) {
        res.status(404).json({ error: 'not_found', message: 'truck not found' })
        return
      }
      res.status(200).json(toPublicTruck(truck))
    })

    app.get('/api/routes', (_req, res) => {
      res.status(200).json([...state.routes.values()].map(toPublicRoute))
    })

    app.post('/api/routes', (req, res) => {
      const actor = requireDispatcher(req, res)
      if (!actor) return
      const truckId = req.body?.truckId
      const destination = req.body?.destination
      if (typeof truckId !== 'string' || !state.trucks.has(truckId)) {
        res.status(400).json({ error: 'invalid_truck', message: 'truckId must reference an existing truck' })
        return
      }
      if (typeof destination !== 'string' || destination.trim() === '') {
        res.status(400).json({ error: 'invalid_destination', message: 'destination is required' })
        return
      }
      const routeId = randomUUID()
      const now = Date.now()
      /** @type {RouteState} */
      const route = {
        routeId,
        truckId,
        status: 'assigned',
        version: 1,
        destination: destination.trim(),
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
        updatedBy: actor,
      }
      state.routes.set(routeId, route)
      const truck = state.trucks.get(truckId)
      if (truck) truck.routeId = routeId
      broadcastWs({ type: 'route_assigned', route: toPublicRoute(route) })
      res.status(201).json(toPublicRoute(route))
    })

    app.patch('/api/routes/:routeId', async (req, res) => {
      const actor = requireDispatcher(req, res)
      if (!actor) return
      const route = state.routes.get(req.params.routeId)
      if (!route) {
        res.status(404).json({ error: 'not_found', message: 'route not found' })
        return
      }
      const status = req.body?.status
      if (typeof status !== 'string' || !(status in LEGAL_TRANSITIONS)) {
        res
          .status(400)
          .json({ error: 'invalid_status', message: 'status must be one of assigned, in-progress, completed, cancelled' })
        return
      }
      await withVersionCheck(req, res, route, (currentRoute) => {
        if (!isValidTransition(currentRoute.status, status)) {
          res
            .status(400)
            .json({ error: 'invalid_transition', message: `cannot transition from ${currentRoute.status} to ${status}` })
          return
        }
        currentRoute.status = /** @type {RouteStatusValue} */ (status)
        bumpVersion(currentRoute, actor)
        if (currentRoute.status === 'completed' || currentRoute.status === 'cancelled') {
          const truck = state.trucks.get(currentRoute.truckId)
          if (truck && truck.routeId === currentRoute.routeId) truck.routeId = null
        }
        broadcastWs({ type: 'route_updated', route: toPublicRoute(currentRoute) })
        res.status(200).json(toPublicRoute(currentRoute))
      })
    })

    app.put('/api/routes/:routeId/reassign', async (req, res) => {
      const actor = requireDispatcher(req, res)
      if (!actor) return
      const route = state.routes.get(req.params.routeId)
      if (!route) {
        res.status(404).json({ error: 'not_found', message: 'route not found' })
        return
      }
      const truckId = req.body?.truckId
      if (typeof truckId !== 'string' || !state.trucks.has(truckId)) {
        res.status(400).json({ error: 'invalid_truck', message: 'truckId must reference an existing truck' })
        return
      }
      if (route.status === 'completed' || route.status === 'cancelled') {
        res.status(400).json({ error: 'invalid_transition', message: 'cannot reassign a terminal route' })
        return
      }
      await withVersionCheck(req, res, route, (currentRoute) => {
        reassignRouteTruck(currentRoute, truckId)
        bumpVersion(currentRoute, actor)
        broadcastWs({ type: 'route_reassigned', route: toPublicRoute(currentRoute) })
        res.status(200).json(toPublicRoute(currentRoute))
      })
    })

    app.post('/api/fleet/:truckId/alert', (req, res) => {
      const actor = requireDispatcher(req, res)
      if (!actor) return
      const truck = state.trucks.get(req.params.truckId)
      if (!truck) {
        res.status(404).json({ error: 'not_found', message: 'truck not found' })
        return
      }
      const message = req.body?.message
      if (typeof message !== 'string' || message.trim() === '') {
        res.status(400).json({ error: 'invalid_message', message: 'message is required' })
        return
      }
      const alert = {
        truckId: truck.truckId,
        message,
        dispatcherId: actor.dispatcherId,
        dispatcherName: actor.name,
        timestamp: Date.now(),
      }
      broadcastWs({ type: 'truck_alert', ...alert })
      res.status(201).json(alert)
    })

    app.get('/api/telemetry/stream', (req, res) => {
      res.status(200)
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.flushHeaders()
      sseClients.add(res)
      req.on('close', () => {
        sseClients.delete(res)
      })
    })

    app.get('/api/telemetry/history/:truckId', (req, res) => {
      const truckId = req.params.truckId
      if (!state.trucks.has(truckId)) {
        res.status(404).json({ error: 'not_found', message: 'truck not found' })
        return
      }
      const buf = state.history.get(truckId) ?? []
      const requested = Number(req.query.limit)
      const limit =
        Number.isFinite(requested) && requested > 0
          ? Math.min(Math.floor(requested), SERVER_PARAMS.TELEMETRY_HISTORY_CAP)
          : Math.min(DEFAULT_HISTORY_LIMIT, SERVER_PARAMS.TELEMETRY_HISTORY_CAP)
      res.status(200).json(buf.slice(-limit))
    })

    app.post('/api/reset', (_req, res) => {
      const fresh = createInitialState()
      state.trucks = fresh.trucks
      state.history = fresh.history
      state.routes = fresh.routes
      forceNext503 = false
      broadcastWs({ type: 'fleet_reset' })
      // Presence survives the reset (AD-17); re-announce every currently
      // present dispatcher so wiped client-side presence caches rebuild.
      for (const entry of presence.values()) {
        broadcastWs({ type: 'dispatcher_joined', dispatcherId: entry.dispatcherId, name: entry.name })
      }
      res.status(200).json({ reset: true })
    })

    // Deterministic quirk triggers — quarantined per AD-11. Nothing under
    // src/ besides server.contract.test.js may reference this path.
    app.post('/api/dev/quirk/:id', (req, res) => {
      const id = Number(req.params.id)
      const handler = quirkHandlers[id]
      if (!handler) {
        res.status(404).json({ error: 'unknown_quirk', message: `no quirk with id ${req.params.id}` })
        return
      }
      res.status(200).json({ quirkId: id, ...handler() })
    })

    // Catch-all for any unmatched method/path — keeps every non-2xx
    // response ApiErrorBody-shaped (src/contract/rest.ts), rather than
    // falling through to Express's default HTML 404 page (review finding).
    app.use((req, res) => {
      res.status(404).json({ error: 'not_found', message: `no route for ${req.method} ${req.path}` })
    })

    // Error-handling middleware — recognized by Express purely by its
    // 4-parameter arity. Catches express.json()'s malformed-body parse
    // failures (and anything a handler above might throw) so those also
    // stay ApiErrorBody-shaped instead of Express's default HTML error
    // page (review finding).
    /**
     * @param {any} err
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} _next
     */
    // eslint-disable-next-line no-unused-vars
    const jsonErrorHandler = (err, _req, res, _next) => {
      const status =
        typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 500
      res
        .status(status)
        .json({ error: 'invalid_request', message: err instanceof Error ? err.message : 'request could not be processed' })
    }
    app.use(jsonErrorHandler)

    return app
  }

  return {
    createApp,
    attachWebSocketHub,
    tick,
    // Instance-level teardown for startServer()'s close(): cancels every
    // pending ghost-disconnect timer, drains SSE clients, and clears
    // non-system presence. Socket/HTTP-server teardown stays in
    // startServer() itself, which owns those objects.
    cleanup: () => {
      for (const timer of pendingGhostTimers) clearTimeout(timer)
      pendingGhostTimers.clear()
      for (const client of sseClients) {
        try {
          client.end()
        } catch {
          // already gone
        }
      }
      sseClients.clear()
      for (const id of [...presence.keys()]) {
        if (id !== SYSTEM_DISPATCHER_ID) presence.delete(id)
      }
    },
  }
}

// ---- Section: server factory / auto-start ----------------------------------

/**
 * @param {{port?: number}} [options]
 * @returns {Promise<FleetPulseServerHandle>}
 */
export function startServer(options = {}) {
  const instance = createFleetPulseInstance()
  const app = instance.createApp()
  const httpServer = http.createServer(app)
  const wss = instance.attachWebSocketHub(httpServer)
  const tickTimer = setInterval(instance.tick, SERVER_PARAMS.TELEMETRY_TICK_MS)

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? SERVER_PARAMS.SERVER_PORT, () => {
      resolve({
        app,
        server: httpServer,
        wss,
        close: () =>
          new Promise((res) => {
            clearInterval(tickTimer)
            instance.cleanup()
            for (const client of wss.clients) client.terminate()
            wss.close(() => {
              httpServer.close(() => res())
            })
          }),
      })
    })
  })
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const envPort = Number(process.env.PORT)
  const port = Number.isFinite(envPort) && envPort > 0 ? envPort : SERVER_PARAMS.SERVER_PORT
  startServer({ port })
    .then(() => {
      console.log(`FleetPulse mock server listening on :${port} (HTTP + WS /ws)`)
    })
    .catch((err) => {
      console.error('Failed to start FleetPulse server', err)
      process.exitCode = 1
    })
}
