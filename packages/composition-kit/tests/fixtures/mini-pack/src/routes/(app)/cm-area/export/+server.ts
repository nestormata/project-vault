import { countCall } from '$lib/server/cm-counter.js'
import type { RequestHandler } from './$types.js'

// Story 68-6: a CM endpoint under (app). Layout loads do not run for +server, so the hook is the
// only gate.
export const GET: RequestHandler = async ({ fetch }) => {
  await countCall(fetch, 'cm-area-export')
  return new Response(JSON.stringify({ cmExport: true }), {
    headers: { 'content-type': 'application/json' },
  })
}
