export type ApiSuccess<T> = { data: T }
export type ApiFailure = {
  code?: string
  error?: string
  message?: string
  details?: unknown
  retryAfter?: number
  retryAfterSeconds?: number
}

export class ApiClientError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown
  readonly body: ApiFailure | null

  constructor(status: number, body: ApiFailure | null, message: string) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = body?.code ?? body?.error
    this.details = body?.details
    this.body = body
  }
}

/**
 * Shared by every `+page.server.ts` load function that gates on MFA enrollment (extensions,
 * sso-domains, external-identities, ...): a 403 with `code: 'mfa_required'` gets its own distinct
 * page state, since retrying alone won't help — never lumped into the generic fetch-error branch.
 */
export function isMfaRequiredError(reason: unknown): boolean {
  return reason instanceof ApiClientError && reason.status === 403 && reason.code === 'mfa_required'
}

export async function parseApiEnvelope<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T

  const body = (await response.json().catch(() => null)) as ApiSuccess<T> | ApiFailure | null
  if (!response.ok) {
    const failure = body && !('data' in body) ? body : null
    const message = failure?.message ?? 'Request failed'
    throw new ApiClientError(response.status, failure, message)
  }

  return body && 'data' in body ? body.data : (body as T)
}

export async function apiFetch<T>(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  // Fastify's default JSON body parser rejects `Content-Type: application/json` paired with an
  // empty body ("Body cannot be empty when content-type is set to 'application/json'"), so only
  // set it when there's actually a body to send.
  const response = await fetchFn(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  return parseApiEnvelope<T>(response)
}

/** Shared by every API module building a query string from optional filter/pagination params
 *  (rotations, credential-shares, ...) — omits keys whose value is `undefined` rather than
 *  serializing the literal string `"undefined"`. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const serialized = search.toString()
  return serialized ? `?${serialized}` : ''
}
