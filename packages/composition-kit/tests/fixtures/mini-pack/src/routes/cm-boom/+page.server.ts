import type { PageServerLoad } from './$types.js'

// Story 68-6 Q7: a forced server error, handled by the CM handleError contribution.
export const load: PageServerLoad = () => {
  throw new Error('cm boom')
}
