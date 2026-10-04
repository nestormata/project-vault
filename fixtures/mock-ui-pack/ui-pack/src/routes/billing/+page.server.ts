import type { PageServerLoad } from './$types.js'

// M2: a new page outside any PV prefix and with no slot (a `/billing`-shaped route).
export const load: PageServerLoad = () => ({ plan: 'mock-ui-pack:m2-billing-plan' })
