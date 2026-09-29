import { env } from '$env/dynamic/private'
import type { RequestHandler } from './$types'
import { proxyHealthRequest } from '$lib/server/api-proxy.js'
import { internalApiFetch } from '$lib/server/internal-api-tls.js'

export const GET: RequestHandler = ({ request }) =>
  proxyHealthRequest({ fetchFn: internalApiFetch, request, apiBaseUrl: env.API_BASE_URL })
