import { HANDOFF_NONCE_COOKIE, postHandoffApi } from '$lib/server/handoff-api.js'
import type { RequestHandler } from './$types'

// Story 73.1 AC2-AC5: the claim hop. A dedicated route (SvelteKit resolves it before the
// `[...path]` catch-all) because it must read the host-only nonce cookie and forward its value in
// the body: the api never sees browser cookies. The cookie is deleted on every request, whatever
// the outcome, so a nonce can be presented once.

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none'])

// AC5: a cross-site request is refused before it reaches the api. The Lax cookie already stays
// home on a cross-site POST; this also stops a same-site sibling (Sec-Fetch-Site: same-site) and
// any foreign or opaque Origin.
function isCrossSite(request: Request, webOrigin: string): boolean {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null && !ALLOWED_FETCH_SITES.has(fetchSite)) return true
  const origin = request.headers.get('origin')
  return origin !== null && origin !== webOrigin
}

async function readToken(request: Request): Promise<string> {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null
  return typeof body?.token === 'string' ? body.token : ''
}

export const POST: RequestHandler = async ({ request, url, cookies }) => {
  const nonce = cookies.get(HANDOFF_NONCE_COOKIE) ?? null
  cookies.delete(HANDOFF_NONCE_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' })

  if (isCrossSite(request, url.origin)) return new Response(null, { status: 403 })

  const response = await postHandoffApi('auth/handoff/claim', request, {
    token: await readToken(request),
    nonce,
  })
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  })
}
