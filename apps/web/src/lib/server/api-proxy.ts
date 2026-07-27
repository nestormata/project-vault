import { trustedApiBase } from './server-api-fetch.js'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

type ProxyOptions = {
  fetchFn: typeof fetch
  request: Request
  apiBaseUrl?: string
}

type ApiProxyOptions = ProxyOptions & {
  path: string
}

function targetUrl(request: Request, apiBaseUrl: string | undefined, pathname: string) {
  const target = new URL(pathname, trustedApiBase(apiBaseUrl))
  target.search = new URL(request.url).search
  return target
}

function forwardedHeaders(request: Request) {
  const headers = new Headers()
  for (const [name, value] of request.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.set(name, value)
  }
  return headers
}

function mutableProxyResponse(response: Response) {
  const headers = new Headers(response.headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function apiUnavailableResponse() {
  return Response.json(
    {
      status: 'unavailable',
      reason: 'api_unreachable',
      message: 'Project Vault API is unavailable.',
    },
    { status: 503 }
  )
}

async function proxyRequest({
  fetchFn,
  request,
  apiBaseUrl,
  pathname,
}: ProxyOptions & { pathname: string }) {
  const hasBody = !['GET', 'HEAD'].includes(request.method)
  let response: Response
  try {
    response = await fetchFn(
      new Request(targetUrl(request, apiBaseUrl, pathname), {
        method: request.method,
        headers: forwardedHeaders(request),
        ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
      } as RequestInit)
    )
  } catch {
    return apiUnavailableResponse()
  }
  return mutableProxyResponse(response)
}

export function proxyApiRequest({ path, ...options }: ApiProxyOptions) {
  return proxyRequest({ ...options, pathname: `/api/v1/${path}` })
}

export function proxyReadyRequest(options: ProxyOptions) {
  return proxyRequest({ ...options, pathname: '/ready' })
}

// The API's liveness endpoint is `/health`, but that literal path is already an app page route
// ((app)/health, the cross-project monitored-services dashboard) — a server-side `fetch('/health')`
// resolves against this app's own routes and can never reach the API. Proxied here under a
// distinct path so `fetchHealth()` (apps/web/src/lib/api/platform.ts) has a real route to call.
export function proxyHealthRequest(options: ProxyOptions) {
  return proxyRequest({ ...options, pathname: '/health' })
}
