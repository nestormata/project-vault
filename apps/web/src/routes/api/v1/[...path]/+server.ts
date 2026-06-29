import { env } from '$env/dynamic/private'
import type { RequestHandler } from './$types'
import { proxyApiRequest } from '$lib/server/api-proxy.js'

const proxy: RequestHandler = ({ params, request }) =>
  proxyApiRequest({
    fetchFn: globalThis.fetch,
    request,
    path: params.path ?? '',
    apiBaseUrl: env.API_BASE_URL,
  })

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
