import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { listOrgs, type OrgListItem } from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

async function fetchOrgsData(fetch: typeof globalThis.fetch) {
  try {
    const result = await listOrgs(fetch)
    return { orgs: result.items, errorMessage: null as string | null }
  } catch (err) {
    const msg =
      err instanceof ApiClientError
        ? (err.message ?? 'Failed to load organizations')
        : 'Failed to load organizations'
    return { orgs: [] as OrgListItem[], errorMessage: msg }
  }
}

const ownLoad = (async ({ fetch, locals }) => {
  if (!platformOperatorGate(locals).allowed) return { allowed: false as const }
  return { allowed: true as const, ...(await fetchOrgsData(fetch)) }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/platform/settings/orgs',
  'page'
)

export const actions = injectActions('/(app)/platform/settings/orgs')
