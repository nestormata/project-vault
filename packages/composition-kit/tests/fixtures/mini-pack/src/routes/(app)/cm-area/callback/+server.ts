import { countCall } from '$lib/server/cm-counter.js'
import type { RequestHandler } from './$types.js'

// Story 68-6 (code review): an OAuth-callback-shaped CM route under (app). The manifest's
// `protectedPaths.remove` takes its derived route id out, so it is reachable anonymously at the
// hook while its siblings stay protected (the CM 16-9 case).
export const GET: RequestHandler = async ({ fetch }) => {
  await countCall(fetch, 'cm-callback')
  return new Response('cm-callback reached')
}
