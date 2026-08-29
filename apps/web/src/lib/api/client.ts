import { browser } from '$app/environment'
import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import { redirect } from '@sveltejs/kit'

export type ApiSuccess<T> = { data: T }
export type ApiFailure = {
  code?: string
  error?: string
  message?: string
  details?: unknown
  retryAfter?: number
  retryAfterSeconds?: number
}

export class ApiClientError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown
  readonly body: ApiFailure | null

  constructor(status: number, body: ApiFailure | null, message: string) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = body?.code ?? body?.error
    this.details = body?.details
    this.body = body
  }
}

/**
 * Shared by every `+page.server.ts` load function that gates on MFA enrollment (extensions,
 * sso-domains, external-identities, ...): a 403 with `code: 'mfa_required'` gets its own distinct
 * page state, since retrying alone won't help — never lumped into the generic fetch-error branch.
 */
export function isMfaRequiredError(reason: unknown): boolean {
  return reason instanceof ApiClientError && reason.status === 403 && reason.code === 'mfa_required'
}

function isRefreshableAccessError(reason: unknown): reason is ApiClientError {
  return (
    reason instanceof ApiClientError &&
    reason.status === 401 &&
    // `session_revoked` fires when a concurrent request's refresh rotation revoked the session
    // this request's access token belonged to (SvelteKit fires several requests per navigation).
    // Retrying picks up the winning session via the server's rotation grace window; if the
    // session is genuinely dead the refresh call itself will fail and the original error surfaces.
    (reason.code === 'access_token_missing' ||
      reason.code === 'access_token_invalid' ||
      reason.code === 'session_revoked')
  )
}

function canReplayRequestBody(body: RequestInit['body']): boolean {
  return body === undefined || body === null || typeof body === 'string'
}

let refreshInFlight: Promise<boolean> | null = null
// Guards against every concurrent apiFetch call independently redirecting when a shared refresh
// fails — SvelteKit fires several requests per navigation (see isRefreshableAccessError), so
// without this a single dead session can trigger the same goto() many times over.
let redirectingToLogin = false

function redirectToSessionExpired(): void {
  if (redirectingToLogin) return
  redirectingToLogin = true
  // Reset once the navigation settles (success or failure) rather than staying latched forever —
  // client-side routing keeps this module alive across the whole SPA session, so a user who logs
  // back in and later hits another dead session must be able to redirect again. `.then(reset,
  // reset)` (not `.catch`/`.finally`) so a rejection is consumed here rather than propagating as
  // an unhandled rejection.
  const reset = () => {
    redirectingToLogin = false
  }
  // resolve() only accepts a known route/pathname, not a route plus an appended query string —
  // the base path segment is still resolved, only the "?reason=..." suffix is a plain string.
  // eslint-disable-next-line svelte/no-navigation-without-resolve
  void goto(`${resolve('/login', {})}?reason=session-expired`).then(reset, reset)
}

function performRefreshRequest(fetchFn: typeof fetch, signal?: AbortSignal): Promise<boolean> {
  return (async () => {
    try {
      const response = await fetchFn('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: {},
        ...(signal ? { signal } : {}),
      })
      if (!response.ok) return false
      await parseApiEnvelope<{ expiresAt: string }>(response)
      return true
    } catch {
      return false
    }
  })()
}

function refreshAccessSession(fetchFn: typeof fetch, signal?: AbortSignal): Promise<boolean> {
  // `refreshInFlight`'s single-flight de-dup is deliberately browser-only. In a browser tab the
  // module instance is scoped to that one session, so sharing it across concurrent apiFetch calls
  // is safe. During SSR, one Node process module instance serves many different users' concurrent
  // requests — sharing this state would let one user's in-flight refresh (and its resulting
  // tokens) leak into a different, concurrently in-flight user's request. So every SSR call
  // performs its own independent refresh instead of joining a shared promise. The extra redundant
  // `/api/v1/auth/refresh` calls this can cause within a single request are safe, thanks to the
  // server's 30-second rotation grace window (architecture.md:353) — a second refresh call just
  // re-issues the same already-rotated tokens idempotently.
  if (!browser) return performRefreshRequest(fetchFn, signal)

  if (refreshInFlight) return refreshInFlight

  const refreshPromise = performRefreshRequest(fetchFn, signal)

  refreshInFlight = refreshPromise
  void refreshPromise.then(
    () => {
      if (refreshInFlight === refreshPromise) refreshInFlight = null
    },
    () => {
      if (refreshInFlight === refreshPromise) refreshInFlight = null
    }
  )
  return refreshPromise
}

export async function parseApiEnvelope<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T

  const body = (await response.json().catch(() => null)) as ApiSuccess<T> | ApiFailure | null
  if (!response.ok) {
    const failure = body && !('data' in body) ? body : null
    const message = failure?.message ?? 'Request failed'
    throw new ApiClientError(response.status, failure, message)
  }

  return body && 'data' in body ? body.data : (body as T)
}

export async function apiFetch<T>(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  // Fastify's default JSON body parser rejects `Content-Type: application/json` paired with an
  // empty body ("Body cannot be empty when content-type is set to 'application/json'"), so only
  // set it when there's actually a body to send.
  const requestInit: RequestInit = {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  }

  let response = await fetchFn(path, requestInit)
  try {
    return await parseApiEnvelope<T>(response)
  } catch (error) {
    // Access tokens are short-lived while the refresh token remains HttpOnly. Retry only this
    // explicit auth failure, once, and only when the request body can be replayed safely. This
    // applies during SSR too — a server-side `load` function hitting this same race deserves the
    // same self-healing retry a browser request already gets, not an unhandled rethrow into a 500.
    if (!isRefreshableAccessError(error)) {
      throw error
    }
    if (!canReplayRequestBody(init.body)) {
      // This specific request can't be safely retried, but that says nothing about whether the
      // session itself is still good — don't treat it as a session-expiry signal.
      throw error
    }
    if (!(await refreshAccessSession(fetchFn, init.signal ?? undefined))) {
      // The refresh token itself is gone/expired — this is a genuinely dead session, not a
      // rotation race (see isRefreshableAccessError). Nothing short of a fresh login can recover
      // it, so send the user there instead of leaving the page stuck on a swallowed/opaque error.
      if (browser) {
        redirectToSessionExpired()
        throw error
      }
      // `goto()` (used by redirectToSessionExpired above) is a client-side-only API and would
      // throw if called here. SvelteKit's own `redirect()` is the SSR-safe equivalent — it throws
      // a special value SvelteKit's routing understands and turns into a real 303 response.
      redirect(303, `${resolve('/login', {})}?reason=session-expired`)
    }
    response = await fetchFn(path, requestInit)
    return parseApiEnvelope<T>(response)
  }
}

/** Shared by every API module building a query string from optional filter/pagination params
 *  (rotations, credential-shares, ...) — omits keys whose value is `undefined` rather than
 *  serializing the literal string `"undefined"`. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const serialized = search.toString()
  return serialized ? `?${serialized}` : ''
}
