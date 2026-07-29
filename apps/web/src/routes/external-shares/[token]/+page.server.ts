import { getExternalShareMetadata, type ExternalShareMetadata } from '$lib/api/credential-shares.js'
import { ApiClientError } from '$lib/api/client.js'
import type { PageServerLoad } from './$types.js'

// Story 17.2 AC-9/AC-21: a genuinely public, UNAUTHENTICATED page — deliberately a standalone
// top-level route (not under `(app)/...`, same convention as this codebase's other public
// unauthenticated page, `routes/status/[token]/`), not the `(app)` route group 17.1's
// authenticated `/shares/[token]` lives under. No `requireUser`/session check of any kind — an
// external recipient has no Project Vault account at all.
export type ExternalShareAccessPageData = {
  token: string
  metadata: ExternalShareMetadata | null
  error: 'not_found' | 'unavailable' | null
}

export const load: PageServerLoad = async ({ params, fetch, setHeaders }) => {
  // AC-10/PR #251 lesson: this page's own document response — the URL that actually carries the
  // raw bearer token in the browser — must set Referrer-Policy itself, not just the API JSON
  // responses (which access-routes.ts already sets). Set from this route's first commit.
  setHeaders({ 'Referrer-Policy': 'no-referrer' })

  try {
    const metadata = await getExternalShareMetadata(fetch, params.token)
    return { token: params.token, metadata, error: null } satisfies ExternalShareAccessPageData
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return {
        token: params.token,
        metadata: null,
        error: 'not_found',
      } satisfies ExternalShareAccessPageData
    }
    // Any other API failure (429 from the GET route's own rate limit, or a 5xx) still gets an
    // honest, distinctly-rendered state on this unauthenticated page rather than falling through
    // to SvelteKit's generic error page — this page has no session to recover into.
    if (error instanceof ApiClientError) {
      return {
        token: params.token,
        metadata: null,
        error: 'unavailable',
      } satisfies ExternalShareAccessPageData
    }
    throw error
  }
}
