import { env } from '$env/dynamic/private'
import { proxyApiRequest } from './api-proxy.js'
import { internalApiFetch } from './internal-api-tls.js'

/**
 * Story 73.1: the nonce-bound handoff's server-to-server calls to apps/api. The browser request's
 * cookies (the nonce cookie and any session) are never forwarded: only the client identity
 * headers the api records on its security events and rate-limits on.
 */
export const HANDOFF_NONCE_COOKIE = '__Host-pv-handoff-nonce'

const CLIENT_IDENTITY_HEADERS = ['user-agent', 'x-forwarded-for', 'x-real-ip', 'forwarded']

export function postHandoffApi(
  path: 'auth/handoff/start' | 'auth/handoff/claim',
  from: Request,
  body: Record<string, unknown> = {}
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const name of CLIENT_IDENTITY_HEADERS) {
    const value = from.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return proxyApiRequest({
    fetchFn: internalApiFetch,
    request: new Request('https://handoff.internal/', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    path,
    apiBaseUrl: env.API_BASE_URL,
  })
}
