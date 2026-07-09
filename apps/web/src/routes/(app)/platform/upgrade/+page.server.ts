import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { fetchHealth, probeApiDocsEnabled } from '$lib/api/platform.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }

  const [health, apiDocsEnabled] = await Promise.all([
    fetchHealth(fetch),
    probeApiDocsEnabled(fetch),
  ])

  return {
    allowed: true as const,
    version: health?.version ?? null,
    apiDocsEnabled,
  }
}
