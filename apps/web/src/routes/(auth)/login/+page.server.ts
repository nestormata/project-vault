import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { resolveNativeLoginEnabled } from '$lib/server/native-login-status.js'
import type { PageServerLoad } from './$types.js'

/**
 * Story 23.2 AC-13: resolved once, server-side, before the first paint — the login screen must
 * already know whether to render the password path without a client-side flash. `null` means
 * the health check failed with no usable cache (a cold-start blip) — the page renders a neutral,
 * retryable "temporarily unavailable" state for that case, never a password form.
 */
const ownLoad = (async ({ fetch }) => {
  const nativeLoginEnabled = await resolveNativeLoginEnabled(fetch)
  return { nativeLoginEnabled }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(auth)/login', 'page')

export const actions = injectActions('/(auth)/login')
