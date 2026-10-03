import type { PageServerLoad } from './$types.js'

// M2: a page under `(app)`: protected by derivation (PV's hook guards its page load, its
// `__data.json` request and its actions by route id). A signed-in user is served; an anonymous
// request is redirected to /login (303) before this load runs.
export const load: PageServerLoad = ({ locals }) => ({
  who: locals.user ? 'a signed-in user' : 'nobody',
})
