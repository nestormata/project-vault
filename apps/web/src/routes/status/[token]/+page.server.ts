import type { PublicStatusPage } from '@project-vault/shared'
import { getPublicStatusPage } from '$lib/api/public-status-page.js'
import type { PageServerLoad } from './$types.js'

// Story 6.3 ADR-6.3-05/Task 10: standalone, top-level route (not under (app)/(auth)) so it is
// exempt from isProtectedAppPath/isAuthPath redirects. Renders a 404-equivalent state on failure
// rather than throwing an unhandled error — this also covers the vault-sealed edge case (Dev
// Notes): if the vault is sealed, the backend call simply fails and the page shows the same
// generic "not available" state used for an invalid/disabled token.
export const load: PageServerLoad = async ({ params, fetch }) => {
  let statusPage: PublicStatusPage | null = null
  try {
    statusPage = await getPublicStatusPage(fetch, params.token)
  } catch {
    statusPage = null
  }
  return { statusPage }
}
