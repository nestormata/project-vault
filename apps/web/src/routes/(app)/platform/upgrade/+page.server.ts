import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { fetchClientVersionPolicy, fetchHealth, probeApiDocsEnabled } from '$lib/api/platform.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  // Story 43.7 AC-5: the gate runs before any fetch — a non-operator triggers no request at all.
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }

  const [health, apiDocsEnabled, cliPolicy] = await Promise.all([
    fetchHealth(fetch),
    probeApiDocsEnabled(fetch),
    // Story 43.7 AC-2: never throws; an unavailable policy never breaks the rest of the page.
    fetchClientVersionPolicy(fetch),
  ])

  return {
    allowed: true as const,
    version: health?.version ?? null,
    // Story 9.10 AC-1/AC-3: sourced from the same /health response as `version` — never
    // inferred, never defaulted to "release" when unknown.
    versionSource: health?.versionSource ?? null,
    apiDocsEnabled,
    cliPolicy,
  }
}
