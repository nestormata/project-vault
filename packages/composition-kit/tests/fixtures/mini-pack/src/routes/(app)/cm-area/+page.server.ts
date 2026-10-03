import type { Actions, PageServerLoad } from './$types.js'

// Story 68-6: a CM page under (app). The composer derives its route id, so PV's hook protects the
// page load, its data request and this action (which runs before any layout load).
export const load: PageServerLoad = ({ locals }) => ({
  who: locals.user ? 'a signed-in user' : 'nobody',
})

export const actions: Actions = { save: () => ({ saved: true }) }
