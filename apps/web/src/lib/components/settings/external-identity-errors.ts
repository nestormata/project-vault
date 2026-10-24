import { ApiClientError } from '$lib/api/client.js'

// AC-2/AC-3 error contract — mirrors /settings/sso-domains's typed ApiClientError.code
// branching rather than blindly relaying error.message for any error (the exact High finding
// 14-6's code review caught and fixed — do not reintroduce it here). Only the codes this
// story's routes actually document are trusted to surface their server message verbatim.
export function externalIdentityErrorMessage(
  error: unknown,
  knownCodes: string[],
  fallback: string
): string {
  if (!(error instanceof ApiClientError)) return fallback
  if (!error.code || !knownCodes.includes(error.code)) return fallback
  return error.message ?? fallback
}
