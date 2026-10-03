import type { RequestHandler } from './$types.js'

// M2: a callback-shaped route under `(app)` declared public with `protectedPaths.remove`, so an
// anonymous provider callback is reachable (recorded in the lock, never refused).
export const GET: RequestHandler = () =>
  new Response(JSON.stringify({ marker: 'mock-ui-pack:m2-public-callback' }), {
    headers: { 'content-type': 'application/json' },
  })
