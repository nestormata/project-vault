import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ url }) => {
  throw redirect(307, `/notifications${url.search}`)
}
