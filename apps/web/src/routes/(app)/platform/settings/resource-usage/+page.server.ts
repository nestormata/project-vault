import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { getResourceUsage, fetchReady, type ResourceUsageResponse } from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }

  let warnings: string[] = []
  try {
    const ready = await fetchReady(fetch)
    warnings = ready.warnings ?? []
  } catch {
    warnings = []
  }

  try {
    const usage = await getResourceUsage(fetch)
    return {
      allowed: true as const,
      usage,
      warnings,
      errorMessage: null as string | null,
    }
  } catch (err) {
    const errorMessage =
      err instanceof ApiClientError
        ? (err.message ?? 'Failed to load resource usage')
        : 'Failed to load resource usage'
    return {
      allowed: true as const,
      usage: null as ResourceUsageResponse | null,
      warnings,
      errorMessage,
    }
  }
}
