import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import type { PublicStatusPage } from '@project-vault/shared'
import { getPublicStatusPage } from '$lib/api/public-status-page.js'
import type { PageServerLoad } from './$types.js'

// Story 6.3 ADR-6.3-05/Task 10: standalone, top-level route (not under (app)/(auth)) so it is
// exempt from isProtectedAppPath/isAuthPath redirects. Renders a 404-equivalent state on failure
// rather than throwing an unhandled error — this also covers the vault-sealed edge case (Dev
// Notes): if the vault is sealed, the backend call simply fails and the page shows the same
// generic "not available" state used for an invalid/disabled token.
//
// Story 69.3 (AC-5.4): the "not available" answer carries `skipInjectedLoads: true`, which
// `withInjectedLoad` consumes (and strips): no contribution load runs for an invalid, disabled or
// sealed token, so a pack cannot use its own load as a token-validity oracle. Contribution loads on
// this anonymous page run without `locals.user` and must return public-safe data only.
interface OwnData {
  statusPage: PublicStatusPage | null
  skipInjectedLoads?: true
}

const ownLoad = (async ({ params, fetch }): Promise<OwnData> => {
  try {
    return { statusPage: await getPublicStatusPage(fetch, params.token) }
  } catch {
    return { statusPage: null, skipInjectedLoads: true }
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/status/[token]', 'page')

export const actions = injectActions('/status/[token]')
