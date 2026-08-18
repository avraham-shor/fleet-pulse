// FleetPulse — mutation gate + circuit breaker (AD-7, AD-8's breaker clause)
//
// The only caller of `fetch` for mutations, and the only caller of
// GET /api/fleet (which the breaker guards) — nothing above transport/
// touches `fetch` or sees a raw `Response`/thrown fetch error. Every
// failure normalizes to one discriminated union (AD-7's Consistency
// Conventions row): `conflict` (409 + body), `retryable` (503 +
// `Retry-After`), `error` (everything else, including a
// locally-synthesized unregistered-mutation refusal — FR-16).

import type {
  Truck,
  Route,
  TruckAlert,
  ApiErrorBody,
  ConflictErrorBody,
  CreateRouteRequestBody,
  UpdateRouteStatusRequestBody,
  ReassignRouteRequestBody,
  SendTruckAlertRequestBody,
} from '../contract/rest.ts'
import { CLIENT_THRESHOLDS } from '../../shared/constants.js'

export type TransportFailure =
  | { kind: 'conflict'; body: ConflictErrorBody }
  | { kind: 'retryable'; retryAfterSeconds: number }
  | { kind: 'error'; body: ApiErrorBody }

export type TransportResult<T> = { ok: true; data: T } | { ok: false; failure: TransportFailure }

export type BreakerState = 'closed' | 'open'

export interface CreateApiClientOptions {
  /** Prefixed to every relative path so Vite's dev proxy forwards requests
   * (vite.config.ts's `/api/` rule); defaults to '' (same-origin relative). */
  baseUrl?: string
  /** Reads the session-scoped `dispatcherId` live (AD-17) — sourced from
   * ws-manager's `getDispatcherId()` by whichever module wires the two
   * together (this story ships both independently and testably; app/'s
   * composition root does the wiring once it exists). */
  getDispatcherId: () => string | null
  fetchImpl?: typeof fetch
  now?: () => number
  setTimeoutImpl?: typeof setTimeout
}

export interface ApiClient {
  /** `GET /api/fleet` — breaker-guarded (FR-25); auto-retries a 503 per its
   * `Retry-After` while the breaker is still closed (FR-24). Not a
   * mutation — no dispatcher header, never refused for being unregistered. */
  getFleet(): Promise<TransportResult<Truck[]>>
  /** `POST /api/routes` (FR-10). No `If-Match` — a create has no version
   * yet (FR-34 covers that race client-side instead). */
  createRoute(body: CreateRouteRequestBody): Promise<TransportResult<Route>>
  /** `PATCH /api/routes/:routeId` (FR-11, FR-12) — `If-Match` echoes
   * `expectedVersion`. */
  updateRouteStatus(
    routeId: string,
    expectedVersion: number,
    body: UpdateRouteStatusRequestBody,
  ): Promise<TransportResult<Route>>
  /** `PUT /api/routes/:routeId/reassign` (FR-14, FR-12) — `If-Match` echoes
   * `expectedVersion`. */
  reassignRoute(
    routeId: string,
    expectedVersion: number,
    body: ReassignRouteRequestBody,
  ): Promise<TransportResult<Route>>
  /** `POST /api/fleet/:truckId/alert` (FR-22). */
  sendTruckAlert(truckId: string, body: SendTruckAlertRequestBody): Promise<TransportResult<TruckAlert>>
  /** Exposed for the health slice / tests — not itself part of the
   * mutation flow. */
  getBreakerState(): BreakerState
  /** Forces the very next `getFleet()` call to attempt a probe immediately,
   * bypassing the scheduled probe time — the seam AD-8/FR-33's future
   * `fleet_reset` sequence uses to "probe immediately if the circuit is
   * open." A no-op in effect while the breaker is already closed (nothing
   * is scheduled to bypass). */
  forceNextProbe(): void
}

const NOT_REGISTERED_FAILURE: TransportFailure = {
  kind: 'error',
  body: {
    error: 'not_registered',
    message: 'No live dispatcher registration — reconnect before mutating.',
  },
}

function invalidResponseFailure(status: number): TransportFailure {
  return { kind: 'error', body: { error: 'invalid_response', message: `response body for status ${status} was not valid JSON` } }
}

function networkErrorFailure(label: string): TransportFailure {
  return { kind: 'error', body: { error: 'network_error', message: `${label} failed to reach the server` } }
}

/** JSON-parse failures never throw past this module — a malformed body is
 * just another failure to normalize, same as a bad status code. */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function parseRetryAfterSeconds(res: Response): number {
  const header = res.headers.get('Retry-After')
  const fallbackSeconds = CLIENT_THRESHOLDS.BREAKER_PROBE_INTERVAL_MS / 1000
  // A genuinely missing header must fall back, not fall through to
  // `Number(null)` — which is `0`, not `NaN`, so it would otherwise pass
  // the finite/non-negative check below and silently return 0.
  if (header === null) return fallbackSeconds
  const parsed = Number(header)
  // Retry-After is read only from the header, never from JSON (story
  // constraint) — a malformed header falls back the same way.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackSeconds
}

function isApiErrorBodyShape(value: unknown): value is ApiErrorBody {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { error?: unknown }).error === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}

function isConflictErrorBodyShape(value: unknown): value is ConflictErrorBody {
  return (
    isApiErrorBodyShape(value) &&
    typeof (value as { conflictingDispatcher?: unknown }).conflictingDispatcher === 'object' &&
    (value as { conflictingDispatcher?: unknown }).conflictingDispatcher !== null &&
    typeof (value as { currentRoute?: unknown }).currentRoute === 'object' &&
    (value as { currentRoute?: unknown }).currentRoute !== null
  )
}

async function readErrorBody(res: Response): Promise<ApiErrorBody> {
  const parsed = await safeJson(res)
  if (isApiErrorBodyShape(parsed)) return parsed
  return { error: 'unknown_error', message: `request failed with status ${res.status}` }
}

export function createApiClient(options: CreateApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl ?? ''
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout

  // --- circuit breaker state (FR-25), scoped to GET /api/fleet only -----
  let breakerState: BreakerState = 'closed'
  let consecutiveFailures = 0
  let nextProbeAtMs = 0

  function openBreaker(retryAfterSeconds: number) {
    breakerState = 'open'
    nextProbeAtMs = now() + Math.max(CLIENT_THRESHOLDS.BREAKER_PROBE_INTERVAL_MS, retryAfterSeconds * 1000)
  }

  function closeBreaker() {
    breakerState = 'closed'
    consecutiveFailures = 0
  }

  function forceNextProbe() {
    // -Infinity rather than 0/now(): guarantees the next getFleet() call's
    // `now() < nextProbeAtMs` check is false regardless of the injected
    // clock's behavior, so the forced probe can never itself be "too soon".
    nextProbeAtMs = Number.NEGATIVE_INFINITY
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeoutImpl(resolve, ms))
  }

  async function fetchFleetOnce(): Promise<TransportResult<Truck[]>> {
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}/api/fleet`)
    } catch {
      return { ok: false, failure: networkErrorFailure('GET /api/fleet') }
    }
    if (res.status === 503) {
      return { ok: false, failure: { kind: 'retryable', retryAfterSeconds: parseRetryAfterSeconds(res) } }
    }
    if (!res.ok) {
      return { ok: false, failure: { kind: 'error', body: await readErrorBody(res) } }
    }
    const data = await safeJson(res)
    if (data === null) return { ok: false, failure: invalidResponseFailure(res.status) }
    return { ok: true, data: data as Truck[] }
  }

  async function getFleet(): Promise<TransportResult<Truck[]>> {
    if (breakerState === 'open') {
      if (now() < nextProbeAtMs) {
        // Further GETs short-circuit locally — no network call at all.
        const retryAfterSeconds = Math.max(0, Math.ceil((nextProbeAtMs - now()) / 1000))
        return { ok: false, failure: { kind: 'retryable', retryAfterSeconds } }
      }
      // Due for a probe: exactly one attempt.
      const probeResult = await fetchFleetOnce()
      if (probeResult.ok) {
        closeBreaker()
        return probeResult
      }
      if (probeResult.failure.kind === 'retryable') {
        openBreaker(probeResult.failure.retryAfterSeconds)
      }
      return probeResult
    }

    // Closed: FR-24's own auto-retry loop honoring Retry-After, each
    // completed attempt counting toward FR-25's 3-strike threshold
    // (retries included).
    for (;;) {
      const result = await fetchFleetOnce()
      if (result.ok) {
        closeBreaker()
        return result
      }
      if (result.failure.kind !== 'retryable') {
        // A non-503 failure never counts toward the breaker (FR-25 is
        // specifically "three consecutive 503s") and is never auto-retried.
        // It also breaks the streak — a 503 that follows it starts counting
        // from zero again, so three 503s split by an unrelated failure
        // never falsely opens the breaker as if they'd been consecutive.
        consecutiveFailures = 0
        return result
      }
      consecutiveFailures += 1
      if (consecutiveFailures >= CLIENT_THRESHOLDS.BREAKER_FAILURE_THRESHOLD) {
        openBreaker(result.failure.retryAfterSeconds)
        return result
      }
      await sleep(result.failure.retryAfterSeconds * 1000)
    }
  }

  async function mutate<T>(
    path: string,
    method: 'POST' | 'PATCH' | 'PUT',
    body: unknown,
    ifMatchVersion?: number,
  ): Promise<TransportResult<T>> {
    const dispatcherId = options.getDispatcherId()
    if (!dispatcherId) {
      // Refused locally, visible reason, no request sent (FR-16) — never a
      // mutation with a missing/empty X-Dispatcher-Id.
      return { ok: false, failure: NOT_REGISTERED_FAILURE }
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Dispatcher-Id': dispatcherId,
    }
    if (ifMatchVersion !== undefined) headers['If-Match'] = String(ifMatchVersion)

    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) })
    } catch {
      return { ok: false, failure: networkErrorFailure(`${method} ${path}`) }
    }
    if (res.status === 409) {
      const parsed = await safeJson(res)
      if (!isConflictErrorBodyShape(parsed)) return { ok: false, failure: invalidResponseFailure(res.status) }
      return { ok: false, failure: { kind: 'conflict', body: parsed } }
    }
    if (res.status === 503) {
      return { ok: false, failure: { kind: 'retryable', retryAfterSeconds: parseRetryAfterSeconds(res) } }
    }
    if (!res.ok) {
      return { ok: false, failure: { kind: 'error', body: await readErrorBody(res) } }
    }
    const data = await safeJson(res)
    if (data === null) return { ok: false, failure: invalidResponseFailure(res.status) }
    return { ok: true, data: data as T }
  }

  return {
    getFleet,
    createRoute: (body) => mutate<Route>('/api/routes', 'POST', body),
    updateRouteStatus: (routeId, expectedVersion, body) =>
      mutate<Route>(`/api/routes/${routeId}`, 'PATCH', body, expectedVersion),
    reassignRoute: (routeId, expectedVersion, body) =>
      mutate<Route>(`/api/routes/${routeId}/reassign`, 'PUT', body, expectedVersion),
    sendTruckAlert: (truckId, body) => mutate<TruckAlert>(`/api/fleet/${truckId}/alert`, 'POST', body),
    getBreakerState: () => breakerState,
    forceNextProbe,
  }
}
