import { redirect } from '@sveltejs/kit'
import type { LayoutServerLoad } from './$types.js'

export const load: LayoutServerLoad = ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login')
  return { user: locals.user }
}
