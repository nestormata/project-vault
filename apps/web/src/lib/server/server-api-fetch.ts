import { getTrustedApiBase } from '$lib/security/hardening.js'

const DEFAULT_API_BASE_URL = 'http://localhost:3000'

type ServerApiFetchOptions = {
  apiBaseUrl?: string | undefined
  fetchFn?: typeof fetch
}

export function trustedApiBase(apiBaseUrl?: string) {
  return getTrustedApiBase({ API_BASE_URL: apiBaseUrl }) || DEFAULT_API_BASE_URL
}

export function apiUrl(path: string, apiBaseUrl?: string) {
  return new URL(path, trustedApiBase(apiBaseUrl)).toString()
}

export function createServerApiFetch({
  apiBaseUrl,
  fetchFn = globalThis.fetch,
}: ServerApiFetchOptions = {}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return fetchFn(apiUrl(input, apiBaseUrl), init)
    }

    return fetchFn(input, init)
  }) as typeof fetch
}
