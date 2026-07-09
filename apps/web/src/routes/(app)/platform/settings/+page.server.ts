import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { getSettings, type SystemSettingsResponse } from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }

  try {
    const settings = await getSettings(fetch)
    return {
      allowed: true as const,
      settings,
      errorMessage: null as string | null,
    }
  } catch (err) {
    const errorMessage =
      err instanceof ApiClientError
        ? (err.message ?? 'Failed to load settings')
        : 'Failed to load settings'
    return {
      allowed: true as const,
      settings: null as SystemSettingsResponse | null,
      errorMessage,
    }
  }
}
