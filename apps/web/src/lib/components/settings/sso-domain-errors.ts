import { ApiClientError } from '$lib/api/client.js'
import { ORG_SSO_DOMAIN_ERROR_CODES } from '@project-vault/shared'

// AC-2/AC-3 error contract — mirrors /settings/users's onRemoveOrgUser pattern: branch on the
// typed ApiClientError.code rather than blindly relaying error.message for any error. Only the
// five contract codes from ORG_SSO_DOMAIN_ERROR_CODES are trusted to surface their server
// message verbatim; any other/unexpected code (e.g. an unrelated 500) falls back to the
// caller-supplied generic copy instead of leaking an unvetted server string to the admin.
const KNOWN_SSO_DOMAIN_ERROR_CODES: readonly string[] = Object.values(ORG_SSO_DOMAIN_ERROR_CODES)
export function errorMessageFor(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback
  if (!error.code || !KNOWN_SSO_DOMAIN_ERROR_CODES.includes(error.code)) return fallback
  return error.message ?? fallback
}
