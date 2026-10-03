import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// The same replaced module imported from server-only code builds.
export const load: PageServerLoad = ({ locals }) => ({ orgName: requireUser(locals).orgName })
