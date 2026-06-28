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

export async function resolveAuthContext({
  fetchFn,
  cookieHeader,
  forwardSetCookie,
}: ResolveAuthOptions): Promise<AuthGuardResult> {
  const meResponse = await fetchMe(fetchFn, cookieHeader)
  if (meResponse.ok) {
    const user = await readData<AuthUser>(meResponse)
    return user ? { status: 'authenticated', user } : { status: 'unauthenticated' }
  }

  if (meResponse.status !== 401) return { status: 'unauthenticated' }

  const refreshResponse = await fetchRefresh(fetchFn, cookieHeader)
  if (!refreshResponse.ok) return { status: 'unauthenticated', reason: SESSION_EXPIRED_REASON }

  const setCookie = refreshResponse.headers.get('set-cookie')
  if (setCookie) forwardSetCookie?.(setCookie)

  const retryMeResponse = await fetchMe(fetchFn, cookieHeader)
  if (!retryMeResponse.ok) return { status: 'unauthenticated', reason: SESSION_EXPIRED_REASON }

  const user = await readData<AuthUser>(retryMeResponse)
  return user
    ? { status: 'authenticated', user }
    : { status: 'unauthenticated', reason: SESSION_EXPIRED_REASON }
}

export function isProtectedAppPath(pathname: string) {
  return ['/dashboard', '/projects', '/credentials', '/alerts', '/health', '/settings'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

export function isAuthPath(pathname: string) {
  return pathname === '/login' || pathname === '/register'
}
