import { injectActions, injectLoad } from '$lib/server/composition/inject-behavior.js'
import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types.js'
import { getVaultReadiness } from '$lib/api/vault.js'

const ownLoad = (async ({ fetch, locals }) => {
  const readiness = await getVaultReadiness(fetch)
  if (readiness.state !== 'ready') throw redirect(303, '/vault')
  throw redirect(303, locals.user ? '/dashboard' : '/login')
}) satisfies PageServerLoad

// PV's own load always redirects, so nothing after it runs; the call keeps the page able to receive
// injected data if that ever changes (the coverage guard requires it on every page server file).
export const load: PageServerLoad = async (event) => {
  await ownLoad(event)
  return injectLoad(event, '/', 'page')
}

export const actions = injectActions('/')
