import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { getResourceUsage, fetchReady, type ResourceUsageResponse } from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

async function fetchResourceWarnings(fetch: typeof globalThis.fetch): Promise<string[]> {
  try {
    const ready = await fetchReady(fetch)
    return ready.warnings ?? []
  } catch {
    return []
  }
}

async function fetchUsageData(
  fetch: typeof globalThis.fetch,
  warnings: string[]
): Promise<{
  usage: ResourceUsageResponse | null
  warnings: string[]
  errorMessage: string | null
}> {
  try {
    const usage = await getResourceUsage(fetch)
    return { usage, warnings, errorMessage: null }
  } catch (err) {
    const errorMessage =
      err instanceof ApiClientError
        ? (err.message ?? 'Failed to load resource usage')
        : 'Failed to load resource usage'
    return { usage: null, warnings, errorMessage }
  }
}

const ownLoad = (async ({ fetch, locals }) => {
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }
  const warnings = await fetchResourceWarnings(fetch)
  return { allowed: true as const, ...(await fetchUsageData(fetch, warnings)) }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/platform/settings/resource-usage',
  'page'
)

export const actions = injectActions('/(app)/platform/settings/resource-usage')
