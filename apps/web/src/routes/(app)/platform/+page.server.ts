import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { fetchReady } from '$lib/api/platform.js'

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

  return { allowed: true as const, warnings }
}
