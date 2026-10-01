import { ApiClientError, type ApiFailure } from '$lib/api/client.js'

/**
 * Story 68.1 (Q2): an `ApiClientError` whose body carries endpoint-specific fields next to the
 * standard envelope (e.g. quota_overcommit's byte counts, a rotation conflict's rotationId), the
 * way the API sends them. Lets a test build that body as an object literal without a cast.
 */
export function apiClientError(
  status: number,
  body: ApiFailure & Record<string, unknown>,
  message: string
): ApiClientError {
  return new ApiClientError(status, body, message)
}
