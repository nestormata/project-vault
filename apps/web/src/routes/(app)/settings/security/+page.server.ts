import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = ({ locals }) => {
  return { user: requireUser(locals) }
}
