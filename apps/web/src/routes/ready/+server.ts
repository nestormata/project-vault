import { env } from '$env/dynamic/private'
import type { RequestHandler } from './$types'
import { proxyReadyRequest } from '$lib/server/api-proxy.js'

export const GET: RequestHandler = ({ fetch, request }) =>
  proxyReadyRequest({ fetchFn: fetch, request, apiBaseUrl: env.API_BASE_URL })
