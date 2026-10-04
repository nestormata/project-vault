import { env } from '$env/dynamic/private'
import { countCall } from '$lib/server/cm-counter.js'

// Story 69.2: runs through the credential page's behavior table because the contribution opted in with
// `hostRoutes` (a region point has no route of its own). It runs as the caller, counts itself, and
// returns an id-free marker naming who the API says the caller is.
export const load = async ({ fetch }: { fetch: typeof globalThis.fetch }) => {
  await countCall(fetch, 'inject-load-credential')
  const me = await fetch(`${env.API_BASE_URL}/api/v1/auth/me`)
  const body = (await me.json()) as { data?: { userId?: string } }
  return { who: `credential:${body.data?.userId ?? 'anonymous'}` }
}
