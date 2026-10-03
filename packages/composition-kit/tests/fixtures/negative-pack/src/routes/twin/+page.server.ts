import { stored } from '$lib/server/_cm/server/store.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = () => ({ stored })
