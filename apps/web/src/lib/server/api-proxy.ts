import { getTrustedApiBase } from '$lib/security/hardening.js'

const DEFAULT_API_BASE_URL = 'http://localhost:3000'
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
  apiBaseUrl?: string | undefined
}

type ApiProxyOptions = ProxyOptions & {
  path: string
}

function trustedApiBase(apiBaseUrl?: string) {
  return getTrustedApiBase({ API_BASE_URL: apiBaseUrl }) || DEFAULT_API_BASE_URL
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

async function proxyRequest({
  fetchFn,
  request,
  apiBaseUrl,
  pathname,
}: ProxyOptions & { pathname: string }) {
  const hasBody = !['GET', 'HEAD'].includes(request.method)
  return fetchFn(
    new Request(targetUrl(request, apiBaseUrl, pathname), {
      method: request.method,
      headers: forwardedHeaders(request),
      ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
    } as RequestInit)
  )
}

export function proxyApiRequest({ path, ...options }: ApiProxyOptions) {
  return proxyRequest({ ...options, pathname: `/api/v1/${path}` })
}

export function proxyReadyRequest(options: ProxyOptions) {
  return proxyRequest({ ...options, pathname: '/ready' })
}
