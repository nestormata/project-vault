import { Money } from '$lib/cm-money.js'
import { countCall } from '$lib/server/cm-counter.js'
import type { Actions, PageServerLoad } from './$types.js'

// Story 68-6: a CM page under (app). The composer derives its route id, so PV's hook protects the
// page load, its data request and this action (which runs before any layout load).
export const load: PageServerLoad = async ({ locals, fetch }) => {
  await countCall(fetch, 'cm-area-load')
  return { who: locals.user ? 'a signed-in user' : 'nobody', price: new Money(5, 'USD') }
}

export const actions: Actions = {
  save: async ({ fetch }) => {
    await countCall(fetch, 'cm-area-action')
    return { saved: true }
  },
}
