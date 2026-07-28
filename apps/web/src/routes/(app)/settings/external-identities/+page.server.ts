import { isMfaRequiredError } from '$lib/api/client.js'
import { listExternalIdentities, type ExternalIdentity } from '$lib/api/external-identities.js'
import { listOrgUsers, type OrgUser } from '$lib/api/org-users.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Story 14.7 AC-4 Judgment Call: reuse the existing POST route's allowedRoles: ['admin'] exactly
// (owner excluded) — NOT 14-6's minimumRole: 'admin' (owner included). See the story's Dev Notes
// for the full rationale: this file's sibling POST route already made this choice (Story 14.3),
// diverging the new GET/DELETE routes would let 'owner' create-but-not-list-or-delete on the
// same resource.
const EXTERNAL_IDENTITIES_PAGE_ROLE = 'admin'

const GENERIC_FETCH_ERROR = 'Failed to load external identities, try again.'

export type ExternalIdentitiesPageData =
  | { allowed: false; orgRole: string }
  | {
      allowed: true
      orgRole: string
      mfaRequired: boolean
      identities: ExternalIdentity[]
      orgUsers: OrgUser[]
      errorMessage: string | null
    }

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole

  // AC-5 least-privilege: a blocked role never triggers the list call at all — avoids a
  // guaranteed wasted 403 round-trip, mirroring /settings/extensions's and /settings/sso-domains's
  // pattern.
  if (orgRole !== EXTERNAL_IDENTITIES_PAGE_ROLE) {
    return { allowed: false as const, orgRole }
  }

  try {
    const [identities, orgUsers] = await Promise.all([
      listExternalIdentities(fetch),
      listOrgUsers(fetch),
    ])
    return {
      allowed: true as const,
      orgRole,
      mfaRequired: false,
      identities,
      orgUsers,
      errorMessage: null,
    }
  } catch (error) {
    // AC-5 edge: an admin who hasn't enrolled in MFA gets a distinct 403 mfa_required from the
    // API (requireMfa: true on every route including the read-only list) — not a generic fetch
    // failure, since retrying alone won't help.
    if (isMfaRequiredError(error)) {
      return {
        allowed: true as const,
        orgRole,
        mfaRequired: true,
        identities: [],
        orgUsers: [],
        errorMessage: null,
      }
    }
    return {
      allowed: true as const,
      orgRole,
      mfaRequired: false,
      identities: [],
      orgUsers: [],
      errorMessage: GENERIC_FETCH_ERROR,
    }
  }
}
