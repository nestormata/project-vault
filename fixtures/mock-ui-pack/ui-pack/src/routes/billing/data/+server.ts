import type { RequestHandler } from './$types.js'

// M2: a JSON endpoint beside the page. SvelteKit answers 405 for every verb not exported here.
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

export const GET: RequestHandler = () => json({ marker: 'mock-ui-pack:m2-billing-data' })

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json()) as { echo?: string }
  return json({ marker: 'mock-ui-pack:m2-billing-post', echo: body.echo ?? null })
}
