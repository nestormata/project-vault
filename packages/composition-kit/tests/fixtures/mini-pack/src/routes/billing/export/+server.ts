import type { RequestHandler } from './$types.js'

export const GET: RequestHandler = () =>
  new Response(JSON.stringify({ exported: true }), {
    headers: { 'content-type': 'application/json' },
  })
