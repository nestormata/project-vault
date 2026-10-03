import { countCall } from '$lib/server/cm-counter.js'
import type { PageServerLoad } from './$types.js'

// Story 68-6: a CM page in a nested group with a dynamic segment, protected by derivation.
export const load: PageServerLoad = async ({ params, fetch }) => {
  await countCall(fetch, 'cm-ledger-load')
  return { id: params.id }
}
