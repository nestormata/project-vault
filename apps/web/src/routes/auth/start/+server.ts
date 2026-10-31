import { redirect } from '@sveltejs/kit'
import { HANDOFF_NONCE_COOKIE, postHandoffApi } from '$lib/server/handoff-api.js'
import type { RequestHandler } from './$types'

// Story 73.1 AC1: the first hop of the nonce-bound handoff. The api mints the nonce and stores its
// HMAC; this route binds it to the browser in a host-only cookie (the `__Host-` prefix forbids a
// Domain attribute, so a sibling subdomain cannot toss one in) and sends the browser to the issuer
// with the nonce in the query. Any failure lands on /auth/claim with no fragment and no cookie,
// which shows the generic error.
const NONCE_TTL_SECONDS = 120
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const FAILURE_LOCATION = '/auth/claim'

type StartData = { nonce: string; redirectUrl: string }

function parseStartData(body: unknown): StartData | null {
  const data = (body as { data?: { nonce?: unknown; redirectUrl?: unknown } } | null)?.data
  const nonce = data?.nonce
  const redirectUrl = data?.redirectUrl
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return null
  if (typeof redirectUrl !== 'string' || !URL.canParse(redirectUrl)) return null
  const protocol = new URL(redirectUrl).protocol
  if (protocol !== 'https:' && protocol !== 'http:') return null
  return { nonce, redirectUrl }
}

async function requestStart(request: Request): Promise<StartData | null> {
  try {
    const response = await postHandoffApi('auth/handoff/start', request)
    if (response.status !== 200) return null
    return parseStartData(await response.json().catch(() => null))
  } catch {
    return null
  }
}

export const GET: RequestHandler = async ({ request, cookies }) => {
  const start = await requestStart(request)
  if (!start) redirect(303, FAILURE_LOCATION)

  cookies.set(HANDOFF_NONCE_COOKIE, start.nonce, {
    httpOnly: true,
    // Required by the `__Host-` prefix; Chromium also accepts Secure cookies on http://localhost.
    secure: true,
    // Lax: the cookie must ride the issuer's top-level redirect back to /auth/claim, and is still
    // withheld from cross-site subresource and POST requests.
    sameSite: 'lax',
    path: '/',
    maxAge: NONCE_TTL_SECONDS,
  })
  redirect(303, start.redirectUrl)
}
