import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types.js'
import { getVaultReadiness } from '$lib/api/vault.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const readiness = await getVaultReadiness(fetch)
  if (readiness.state !== 'ready') throw redirect(303, '/vault')
  throw redirect(303, locals.user ? '/dashboard' : '/login')
}
