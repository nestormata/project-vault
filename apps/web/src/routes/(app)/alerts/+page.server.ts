import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ url }) => {
  // 308 (permanent) per ADR-3.4-04 — preserves bookmarks/external doc links to /alerts.
  throw redirect(308, `/notifications${url.search}`)
}
