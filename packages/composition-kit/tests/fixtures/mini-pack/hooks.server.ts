import type { Handle } from '@sveltejs/kit'
import { formatPlan } from './src/lib/cm-format.js'

// A CM server hook contribution: materialized under src/lib/server/_cm (Story 68-6 composes it).
export const hookLabel = formatPlan('hook')

export const handle: Handle = ({ event, resolve }) => resolve(event)
