import { env } from '$env/dynamic/private'
import type { RequestHandler } from './$types'
import { proxyApiRequest } from '$lib/server/api-proxy.js'
import {
  corsResponseHeaders,
  isOriginAllowed,
  parseAllowedOrigins,
} from '$lib/server/handoff-cors.js'

// Story 30.5 — a dedicated route for exactly `POST /api/v1/auth/handoff/prepare`, resolved by
// SvelteKit before the generic `[...path]` catch-all (AC3.13, confirmed by
// `prepare-server.test.ts`'s routing-precedence test). This is the ONE route CM's cross-origin
// interstitial calls directly (see Background); every other `apps/web` API call, including this
// same flow's own Confirm step, stays same-origin through the existing, unmodified catch-all
// proxy — do not widen CORS handling onto that shared route.

function readAllowedOrigins(): Set<string> {
  return parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS)
}

// AC3.12: this story picks "short-circuit BEFORE proxying" — an origin absent from the allowlist
// never reaches `apps/api` at all, so it can never influence `apps/api`'s rate-limit counters or
// write a rejection/audit event for a token it was never going to be allowed to submit in the
// first place. Documented here as the deliberate choice the AC calls out as needing one.
function rejectDisallowedOrigin(): Response {
  return new Response(null, { status: 403 })
}

export const OPTIONS: RequestHandler = ({ request }) => {
  const origin = request.headers.get('origin')
  if (!isOriginAllowed(origin, readAllowedOrigins())) {
    return rejectDisallowedOrigin()
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsResponseHeaders(origin as string),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}

export const POST: RequestHandler = async ({ request }) => {
  const origin = request.headers.get('origin')
  if (!isOriginAllowed(origin, readAllowedOrigins())) {
    return rejectDisallowedOrigin()
  }

  const response = await proxyApiRequest({
    fetchFn: globalThis.fetch,
    request,
    path: 'auth/handoff/prepare',
    apiBaseUrl: env.API_BASE_URL,
  })

  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(corsResponseHeaders(origin as string))) {
    headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
