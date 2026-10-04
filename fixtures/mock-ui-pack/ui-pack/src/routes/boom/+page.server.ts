import type { PageServerLoad } from './$types.js'

// M1 (d): a pack route that throws, to force a 500 through the pack's root `+error.svelte`. The
// message carries a marker on purpose: the error page must show SvelteKit's sanitised message,
// never this text and never a stack.
export const load: PageServerLoad = () => {
  throw new Error('mock-ui-pack boom-internal-detail that must not reach the page')
}
