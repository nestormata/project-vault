import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { getSettings, type SystemSettingsResponse } from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

async function fetchSettingsData(fetch: typeof globalThis.fetch) {
  try {
    const settings = await getSettings(fetch)
    return { settings, errorMessage: null as string | null }
  } catch (err) {
    return {
      settings: null as SystemSettingsResponse | null,
      errorMessage:
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to load settings')
          : 'Failed to load settings',
    }
  }
}

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const gateResult = platformOperatorGate(locals)
  if (!gateResult.allowed) return { allowed: false as const }
  const data = await fetchSettingsData(fetch)
  return { allowed: true as const, ...data }
}
