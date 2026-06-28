import type { AuthUser } from '$lib/api/auth.js'

export type AuthGuardResult =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'unauthenticated'; reason?: 'session-expired' }

type ResolveAuthOptions = {
  fetchFn: typeof fetch
  cookieHeader?: string | null
  forwardSetCookie?: (value: string) => void
}

const AUTH_ME_PATH = '/api/v1/auth/me'
const AUTH_REFRESH_PATH = '/api/v1/auth/refresh'
const SESSION_EXPIRED_REASON = 'session-expired'

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

async function refreshAndRetry({
  fetchFn,
  cookieHeader,
  forwardSetCookie,
}: ResolveAuthOptions): Promise<AuthGuardResult> {
  let refreshResponse: Response
  try {
    refreshResponse = await fetchRefresh(fetchFn, cookieHeader)
  } catch {
    return { status: 'unauthenticated', reason: SESSION_EXPIRED_REASON }
  }
  if (!refreshResponse.ok) return { status: 'unauthenticated', reason: SESSION_EXPIRED_REASON }

  const setCookieHeaders = getSetCookieHeaders(refreshResponse.headers)
  for (const setCookie of setCookieHeaders) forwardSetCookie?.(setCookie)

  const retryCookieHeader = mergeCookieHeader(cookieHeader, setCookieHeaders)
  let retryMeResponse: Response
  try {
    retryMeResponse = await fetchMe(fetchFn, retryCookieHeader || cookieHeader)
  } catch {
    return { status: 'unauthenticated', reason: SESSION_EXPIRED_REASON }
  }
  if (!retryMeResponse.ok) return { status: 'unauthenticated', reason: SESSION_EXPIRED_REASON }

  const user = await readData<AuthUser>(retryMeResponse)
  return user
    ? { status: 'authenticated', user }
    : { status: 'unauthenticated', reason: SESSION_EXPIRED_REASON }
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
    return { status: 'unauthenticated' }
  }
  if (meResponse.ok) return authenticatedResult(meResponse)
  if (meResponse.status !== 401) return { status: 'unauthenticated' }
  if (!hasRefreshCookie(cookieHeader)) return { status: 'unauthenticated' }
  return refreshAndRetry({ fetchFn, cookieHeader, forwardSetCookie })
}

export function isProtectedAppPath(pathname: string) {
  return ['/dashboard', '/projects', '/credentials', '/alerts', '/health', '/settings'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

export function isAuthPath(pathname: string) {
  return pathname === '/login' || pathname === '/register'
}
