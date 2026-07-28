import { ApiClientError } from '$lib/api/client.js'
import { listOrgSsoDomains, type OrgSsoDomain } from '$lib/api/org-sso-domains.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Story 14.6 AC-5 Dev Notes judgment call: `minimumRole: 'admin'` on the API (rank-based, admits
// both 'admin' and 'owner') — mirrored here so the page's own gate agrees with the API it calls.
// Deliberately NOT Story 14.5's exact-match allowedRoles: ['admin'] (which excludes owner) — see
// the story's Dev Notes for the full rationale.
function canManageSsoDomains(orgRole: string): boolean {
  return orgRole === 'admin' || orgRole === 'owner'
}

const GENERIC_FETCH_ERROR = 'Failed to load SSO domains, try again.'

export type SsoDomainsPageData =
  | { allowed: false; orgRole: string }
  | {
      allowed: true
      orgRole: string
      mfaRequired: boolean
      domains: OrgSsoDomain[]
      errorMessage: string | null
    }

function isMfaRequiredError(reason: unknown): boolean {
  return reason instanceof ApiClientError && reason.status === 403 && reason.code === 'mfa_required'
}

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole

  // AC-5 least-privilege: a blocked role never triggers the list call at all — avoids a
  // guaranteed wasted 403 round-trip, mirroring /settings/extensions's Task 3 pattern.
  if (!canManageSsoDomains(orgRole)) {
    return { allowed: false as const, orgRole }
  }

  try {
    const domains = await listOrgSsoDomains(fetch)
    return { allowed: true as const, orgRole, mfaRequired: false, domains, errorMessage: null }
  } catch (error) {
    // AC-6 edge: an admin/owner who hasn't enrolled in MFA gets a distinct 403 mfa_required from
    // the API (requireMfa: true on every route including the read-only list) — not a generic
    // fetch failure, since retrying alone won't help.
    if (isMfaRequiredError(error)) {
      return { allowed: true as const, orgRole, mfaRequired: true, domains: [], errorMessage: null }
    }
    return {
      allowed: true as const,
      orgRole,
      mfaRequired: false,
      domains: [],
      errorMessage: GENERIC_FETCH_ERROR,
    }
  }
}
