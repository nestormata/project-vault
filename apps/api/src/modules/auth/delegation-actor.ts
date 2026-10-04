import { and, eq } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { externalIdentities } from '@project-vault/db/schema'
import { activeMembershipRoleQuery } from '../../plugins/authenticate.js'
import type { OrgRole } from '../../plugins/require-org-role.js'

/**
 * Story 71.3 (design check 13): resolves the actor of a verified delegation assertion inside the
 * RESOLVED org's RLS scope. Read only: PV never creates a user, role, session or
 * `external_identities` row from an assertion.
 *
 * - `member`: an `external_identities` row for `(org, provider, subject)` AND an active membership
 *   in this org. Carries the membership role.
 * - `non_member`: a link exists but the user has no ACTIVE membership here (deactivated, or no
 *   membership row at all). The link row is org-scoped, so a link in ANOTHER org is invisible and
 *   the actor is `unlinked` here.
 * - `unlinked`: no link row in this org (Q6: admitted as issuer-attested by the caller).
 */
export type DelegatedActorResolution =
  | { readonly kind: 'member'; readonly userId: string; readonly orgRole: OrgRole }
  | { readonly kind: 'non_member'; readonly userId: string }
  | { readonly kind: 'unlinked' }

export type DelegatedActorLookup = {
  /** The RESOLVED PV org id, never the raw `org` claim. */
  orgId: string
  /** `claims.actor.provider`. */
  provider: string
  /** `claims.actor.subject`; used as a query parameter only, never logged or returned. */
  subject: string
}

const ORG_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member', 'viewer'])

function linkedUserQuery(tx: Tx, lookup: DelegatedActorLookup) {
  return tx
    .select({ userId: externalIdentities.userId })
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.orgId, lookup.orgId),
        eq(externalIdentities.providerName, lookup.provider),
        eq(externalIdentities.externalSubject, lookup.subject)
      )
    )
    .limit(1)
}

export async function resolveDelegatedActor(
  lookup: DelegatedActorLookup
): Promise<DelegatedActorResolution> {
  return withOrg(lookup.orgId, async (tx) => {
    const linked = (await linkedUserQuery(tx, lookup))[0]
    if (!linked) return { kind: 'unlinked' as const }
    const membership = (await activeMembershipRoleQuery(tx, linked.userId, lookup.orgId))[0]
    if (!membership || !ORG_ROLES.has(membership.role)) {
      return { kind: 'non_member' as const, userId: linked.userId }
    }
    return { kind: 'member' as const, userId: linked.userId, orgRole: membership.role as OrgRole }
  })
}
