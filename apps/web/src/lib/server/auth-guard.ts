import type { AuthUser } from '$lib/api/auth.js'
import { PV_PROTECTED_PREFIXES, matchesPrefix } from './protected-paths.js'

/** Why the auth API could not answer (Story 68-27). Safe to log: carries no upstream content. */
export type AuthUnavailableCategory = 'rate_limited' | 'upstream_error' | 'transport'

/**
 * `unavailable` means the session state is UNKNOWN (the auth API throttled, failed or was
 * unreachable). It is never a sign-out: callers refuse with a retryable status instead of
 * redirecting to /login. `retryAfter` is already sanitized (see `sanitizeRetryAfter`).
 */
export type AuthGuardResult =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'unauthenticated'; reason?: 'session-expired' }
  | { status: 'unavailable'; category: AuthUnavailableCategory; retryAfter?: string }

type ResolveAuthOptions = {
  fetchFn: typeof fetch
  cookieHeader?: string | null
  forwardSetCookie?: (value: string) => void
}

const AUTH_ME_PATH = '/api/v1/auth/me'
const AUTH_REFRESH_PATH = '/api/v1/auth/refresh'
const SESSION_EXPIRED_REASON = 'session-expired'

const MAX_RETRY_AFTER_SECONDS = 86_400

/**
 * Only a bounded delay-seconds integer or a future HTTP-date within 24 h is passed on; anything
 * else (negative, non-numeric, huge, a past date, a list) is dropped rather than relayed.
 */
function sanitizeRetryAfter(value: string | null): string | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d{1,6}$/.test(trimmed)) {
    // `0` is dropped: a client honouring it would retry at once and feed the burst.
    const seconds = Number(trimmed)
    return seconds >= 1 && seconds <= MAX_RETRY_AFTER_SECONDS ? trimmed : undefined
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed))
    return undefined
  const delayMs = Date.parse(trimmed) - Date.now()
  return delayMs > 0 && delayMs <= MAX_RETRY_AFTER_SECONDS * 1000 ? trimmed : undefined
}

function unavailable(
  category: AuthUnavailableCategory,
  retryAfter?: string
): Extract<AuthGuardResult, { status: 'unavailable' }> {
  return retryAfter === undefined
    ? { status: 'unavailable', category }
    : { status: 'unavailable', category, retryAfter }
}

/** 429 and every 5xx are retryable upstream refusals; null for any other status. */
function unavailableFromStatus(response: Response) {
  if (response.status === 429) {
    return unavailable('rate_limited', sanitizeRetryAfter(response.headers.get('retry-after')))
  }
  if (response.status >= 500) {
    return unavailable('upstream_error', sanitizeRetryAfter(response.headers.get('retry-after')))
  }
  return null
}

function cookieHeaders(cookieHeader?: string | null) {
  return cookieHeader ? { Cookie: cookieHeader } : undefined
}

function hasRefreshCookie(cookieHeader?: string | null) {
  return cookieHeader?.split(';').some((part) => part.trim().startsWith('refresh-token=')) === true
}

function splitSetCookieHeader(value: string): string[] {
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean)
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  if (getSetCookie) return getSetCookie.call(headers).flatMap(splitSetCookieHeader)
  const combined = headers.get('set-cookie')
  return combined ? splitSetCookieHeader(combined) : []
}

function mergeCookieHeader(cookieHeader: string | null | undefined, setCookieHeaders: string[]) {
  const cookies = new Map<string, string>()
  for (const part of cookieHeader?.split(';') ?? []) {
    const [name, ...valueParts] = part.trim().split('=')
    if (name && valueParts.length > 0) cookies.set(name, valueParts.join('='))
  }

  for (const setCookie of setCookieHeaders) {
    const [pair] = setCookie.split(';')
    if (!pair) continue
    const [name, ...valueParts] = pair.trim().split('=')
    if (name && valueParts.length > 0) cookies.set(name, valueParts.join('='))
  }

  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

async function fetchMe(fetchFn: typeof fetch, cookieHeader?: string | null) {
  return fetchFn(AUTH_ME_PATH, {
    credentials: 'include',
    ...(cookieHeader ? { headers: cookieHeaders(cookieHeader) } : {}),
  })
}

async function fetchRefresh(fetchFn: typeof fetch, cookieHeader?: string | null) {
  return fetchFn(AUTH_REFRESH_PATH, {
    method: 'POST',
    credentials: 'include',
    ...(cookieHeader ? { headers: cookieHeaders(cookieHeader) } : {}),
  })
}

async function readData<T>(response: Response): Promise<T | null> {
  const body = (await response.json().catch(() => null)) as { data?: T } | null
  return body?.data ?? null
}

async function authenticatedResult(response: Response): Promise<AuthGuardResult> {
  const user = await readData<AuthUser>(response)
  return user ? { status: 'authenticated', user } : { status: 'unauthenticated' }
}

const SESSION_EXPIRED: AuthGuardResult = {
  status: 'unauthenticated',
  reason: SESSION_EXPIRED_REASON,
}

/** A refresh the server REJECTED (401/403) ends the session; any other failure is unavailable. */
function failedRefreshResult(response: Response): AuthGuardResult {
  if (response.status === 401 || response.status === 403) return SESSION_EXPIRED
  return unavailableFromStatus(response) ?? unavailable('upstream_error')
}

/** After a successful refresh, a 401 means the new session is not valid; 429/5xx are unknown. */
function failedRetryResult(response: Response): AuthGuardResult {
  return unavailableFromStatus(response) ?? SESSION_EXPIRED
}

async function refreshAndRetry({
  fetchFn,
  cookieHeader,
  forwardSetCookie,
}: ResolveAuthOptions): Promise<AuthGuardResult> {
  let refreshResponse: Response
  try {
    refreshResponse = await fetchRefresh(fetchFn, cookieHeader)
  } catch {
    return unavailable('transport')
  }
  if (!refreshResponse.ok) return failedRefreshResult(refreshResponse)

  const setCookieHeaders = getSetCookieHeaders(refreshResponse.headers)
  for (const setCookie of setCookieHeaders) forwardSetCookie?.(setCookie)

  const retryCookieHeader = mergeCookieHeader(cookieHeader, setCookieHeaders)
  let retryMeResponse: Response
  try {
    retryMeResponse = await fetchMe(fetchFn, retryCookieHeader || cookieHeader)
  } catch {
    return unavailable('transport')
  }
  if (!retryMeResponse.ok) return failedRetryResult(retryMeResponse)

  const user = await readData<AuthUser>(retryMeResponse)
  return user ? { status: 'authenticated', user } : SESSION_EXPIRED
}

export async function resolveAuthContext({
  fetchFn,
  cookieHeader,
  forwardSetCookie,
}: ResolveAuthOptions): Promise<AuthGuardResult> {
  let meResponse: Response
  try {
    meResponse = await fetchMe(fetchFn, cookieHeader)
  } catch {
    return unavailable('transport')
  }
  if (meResponse.ok) return authenticatedResult(meResponse)
  if (meResponse.status !== 401)
    return unavailableFromStatus(meResponse) ?? { status: 'unauthenticated' }
  if (!hasRefreshCookie(cookieHeader)) return { status: 'unauthenticated' }
  return refreshAndRetry({ fetchFn, cookieHeader, forwardSetCookie })
}

// Story 68.6 AC-7: the prefix list is data in `protected-paths.ts` (same 9 entries, same order);
// this keeps its signature and segment-prefix behaviour. The hook itself decides with
// `isProtectedRequest`, which also sees Kit's matched route id.
export function isProtectedAppPath(pathname: string) {
  return matchesPrefix(PV_PROTECTED_PREFIXES, pathname)
}

export function isAuthPath(pathname: string) {
  return pathname === '/login' || pathname === '/register'
}
