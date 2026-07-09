import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { listOrgs, type OrgListItem } from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }

  try {
    const result = await listOrgs(fetch)
    return {
      allowed: true as const,
      orgs: result.items,
      errorMessage: null as string | null,
    }
  } catch (err) {
    const errorMessage =
      err instanceof ApiClientError
        ? (err.message ?? 'Failed to load organizations')
        : 'Failed to load organizations'
    return {
      allowed: true as const,
      orgs: [] as OrgListItem[],
      errorMessage,
    }
  }
}
