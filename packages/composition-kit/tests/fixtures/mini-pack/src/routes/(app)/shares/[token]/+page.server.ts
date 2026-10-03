import type { ShareMetadata } from '$lib/api/credential-shares.js'
import { countCall } from '$lib/server/cm-counter.js'
import type { PageServerLoad } from './$types.js'

// Story 68-6 (code review): a CM override of a PV (app) route outside PV's protected prefixes. The
// composer derives its route id, so the hook gates it (session-expired and sealed-vault redirects
// come from the hook, not from the (app) layout). PV's page component renders the data, so the
// data keeps PV's shape.
interface ShareAccessPageData {
  token: string
  metadata: ShareMetadata | null
  error: 'not_found' | 'session_mismatch' | null
}

export const load: PageServerLoad = async ({ params, fetch, setHeaders }) => {
  // The URL carries the share token: keep PV's no-referrer, as PV's route does.
  setHeaders({ 'Referrer-Policy': 'no-referrer' })
  await countCall(fetch, 'cm-shares-load')
  const data: ShareAccessPageData = { token: params.token, metadata: null, error: 'not_found' }
  return data
}
