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

export const load: PageServerLoad = async ({ fetch, locals }) => {
  if (!platformOperatorGate(locals).allowed) return { allowed: false as const }
  return { allowed: true as const, ...(await fetchOrgsData(fetch)) }
}
