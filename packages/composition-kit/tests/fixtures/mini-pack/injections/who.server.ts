import { env } from '$env/dynamic/private'
import { countCall } from '$lib/server/cm-counter.js'

// Story 68-15: a contribution load that talks to the API through the request's own `fetch`, so it
// runs as the caller. It reads who the caller is and asks for a project of another tenant. It
// catches nothing, because a denial is only a status here. A load that threw on the denial would
// turn a graceful not-found into a 500 (DW-490 item 1: withInjectedLoad rethrows with the point name).
export const load = async ({ fetch }: { fetch: typeof globalThis.fetch }) => {
  await countCall(fetch, 'inject-load')
  const me = await fetch(`${env.API_BASE_URL}/api/v1/auth/me`)
  const body = (await me.json()) as { data?: { userId?: string } }
  const other = await fetch(`${env.API_BASE_URL}/api/v1/projects/p-u2`)
  return { who: `iso:${body.data?.userId ?? 'anonymous'}`, project: other.status }
}
