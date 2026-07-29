import { getShareMetadata, type ShareMetadata } from '$lib/api/credential-shares.js'
import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Story 17.1 AC-8: the two-step consent screen (metadata GET) never touches the reveal-step —
// that only happens client-side, on explicit user action, via POST .../reveal (AC-8's "never on
// first request" requirement).
export type ShareAccessPageData = {
  token: string
  metadata: ShareMetadata | null
  error: 'not_found' | 'session_mismatch' | null
}

export const load: PageServerLoad = async ({ params, fetch, locals, setHeaders }) => {
  requireUser(locals)

  // AC-17: this page's own URL carries the raw bearer token — the document response itself
  // (not just its internal API calls, already covered by access-routes.ts) must not leak it via
  // Referer on any outbound navigation/sub-resource request from this page.
  setHeaders({ 'Referrer-Policy': 'no-referrer' })

  try {
    const metadata = await getShareMetadata(fetch, params.token)
    return { token: params.token, metadata, error: null } satisfies ShareAccessPageData
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return {
        token: params.token,
        metadata: null,
        error: 'not_found',
      } satisfies ShareAccessPageData
    }
    if (error instanceof ApiClientError && error.status === 403) {
      return {
        token: params.token,
        metadata: null,
        error: 'session_mismatch',
      } satisfies ShareAccessPageData
    }
    throw error
  }
}
