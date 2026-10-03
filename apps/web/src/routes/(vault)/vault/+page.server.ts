import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types.js'
import { getVaultReadiness } from '$lib/api/vault.js'

const ownLoad = (async ({ fetch, locals }) => {
  const readiness = await getVaultReadiness(fetch)
  if (readiness.state === 'ready') throw redirect(303, locals.user ? '/dashboard' : '/login')
  return { readiness }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(vault)/vault', 'page')

export const actions = injectActions('/(vault)/vault')
