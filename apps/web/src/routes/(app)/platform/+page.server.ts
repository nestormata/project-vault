import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { fetchReady } from '$lib/api/platform.js'

async function fetchPlatformWarnings(fetch: typeof globalThis.fetch): Promise<string[]> {
  try {
    const ready = await fetchReady(fetch)
    return ready.warnings ?? []
  } catch {
    return []
  }
}

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }
  const warnings = await fetchPlatformWarnings(fetch)
  return { allowed: true as const, warnings }
}
