import { resolveNativeLoginEnabled } from '$lib/server/native-login-status.js'
import type { PageServerLoad } from './$types.js'

// An override of a PV server load, typed against the composed route's own ./$types.
export const load: PageServerLoad = async (event) => ({
  nativeLoginEnabled: await resolveNativeLoginEnabled(event.fetch),
})
