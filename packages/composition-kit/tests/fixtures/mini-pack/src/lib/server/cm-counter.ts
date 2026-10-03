import { env } from '$env/dynamic/private'

// Calls the fixture API stub's counter with the handler's own `fetch` (so the CM handleFetch
// applies). The integration job reads the counters to prove a redirected request ran no handler.
export function countCall(fetchFn: typeof fetch, name: string): Promise<Response> {
  return fetchFn(`${env.API_BASE_URL}/__fixture/count/${name}`)
}
