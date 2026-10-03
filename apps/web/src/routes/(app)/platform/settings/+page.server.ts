import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import {
  getSettings,
  getStatusTokenMetadata,
  type StatusTokenMetadataResponse,
  type SystemSettingsResponse,
} from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

async function fetchSettingsData(
  fetch: typeof globalThis.fetch
): Promise<{ settings: SystemSettingsResponse | null; errorMessage: string | null }> {
  try {
    const settings = await getSettings(fetch)
    return { settings, errorMessage: null }
  } catch (err) {
    return {
      settings: null,
      errorMessage:
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to load settings')
          : 'Failed to load settings',
    }
  }
}

// Story 1.19 AC-5: best-effort — a failure to load the token's metadata must not block the rest
// of the settings page from rendering (same isolation principle as fetchSettingsData above).
// Adversarial review fix: a thrown/5xx failure here is no longer indistinguishable from "no
// token configured" — the caller gets an explicit `loadFailed` flag so the page can render a
// visible "couldn't load" message instead of silently implying the token is unconfigured.
async function fetchStatusTokenMetadata(
  fetch: typeof globalThis.fetch
): Promise<{ statusToken: StatusTokenMetadataResponse | null; statusTokenLoadFailed: boolean }> {
  try {
    return { statusToken: await getStatusTokenMetadata(fetch), statusTokenLoadFailed: false }
  } catch {
    return { statusToken: null, statusTokenLoadFailed: true }
  }
}

const ownLoad = (async ({ fetch, locals }) => {
  const gateResult = platformOperatorGate(locals)
  if (!gateResult.allowed) return { allowed: false as const }
  const data = await fetchSettingsData(fetch)
  const { statusToken, statusTokenLoadFailed } = await fetchStatusTokenMetadata(fetch)
  return { allowed: true as const, ...data, statusToken, statusTokenLoadFailed }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/platform/settings', 'page')

export const actions = injectActions('/(app)/platform/settings')
