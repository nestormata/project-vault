import { env } from '$env/dynamic/private'
import type { RequestHandler } from './$types'
import { proxyHealthRequest } from '$lib/server/api-proxy.js'

export const GET: RequestHandler = ({ request }) =>
  proxyHealthRequest({ fetchFn: globalThis.fetch, request, apiBaseUrl: env.API_BASE_URL })
