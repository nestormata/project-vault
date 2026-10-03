import { injectLoad } from '$lib/server/composition/inject-behavior.js'
import type { LayoutServerLoad } from './$types.js'

export const load: LayoutServerLoad = (event) => injectLoad(event, '/', 'layout')
