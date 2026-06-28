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

export async function apiFetch<T>(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetchFn(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  if (response.status === 204) return undefined as T

  const body = (await response.json().catch(() => null)) as ApiSuccess<T> | ApiFailure | null
  if (!response.ok) {
    const failure = body && !('data' in body) ? body : null
    const message = failure?.message ?? 'Request failed'
    throw new ApiClientError(response.status, failure, message)
  }

  return body && 'data' in body ? body.data : (body as T)
}
