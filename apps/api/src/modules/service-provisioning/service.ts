import { eq, sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { externalIdentities, organizations, orgMemberships, users } from '@project-vault/db/schema'
import { AppError } from '../../lib/errors.js'
import { allocateOrganizationSlug, isUniqueViolation, slugify } from '../auth/service.js'
import { generateUnusablePasswordHash } from '../auth/password.js'
import type { ProvisionServiceOrganizationRequest } from './schema.js'

export const SERVICE_PROVISIONING_PROVIDER_NAME = 'workos'

export type ProvisionServiceOrganizationResult = {
  organizationId: string
  userId: string
  externalIdentityId: string
}

/**
 * Story 26.1 AC-1: reads the winning row for a given requestId (already-provisioned org, its
 * owner user, and its externalIdentities link row). Used both for the idempotent-replay fast path
 * (AC-4) and to resolve a concurrent unique-violation race to the actual winner.
 */
async function findExistingProvisioning(
  tx: Tx,
  requestId: string
): Promise<ProvisionServiceOrganizationResult | null> {
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.serviceProvisioningRequestId, requestId))
    .limit(1)
  if (!org) return null

  // orgMemberships/externalIdentities are RLS-scoped to app.current_org_id — this read-only
  // transaction never had that set (unlike the write path, which sets it right before inserting
  // the membership row), so it must be set here before either SELECT below can see anything.
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${org.id}, true)`)

  const [membership] = await tx
    .select({ userId: orgMemberships.userId })
    .from(orgMemberships)
    .where(eq(orgMemberships.orgId, org.id))
    .limit(1)
  if (!membership) {
    throw new Error(
      `findExistingProvisioning: organization ${org.id} has a service_provisioning_request_id ` +
        'but no membership row — data integrity violation, this should never happen'
    )
  }

  const [identity] = await tx
    .select({ id: externalIdentities.id })
    .from(externalIdentities)
    .where(eq(externalIdentities.orgId, org.id))
    .limit(1)
  if (!identity) {
    throw new Error(
      `findExistingProvisioning: organization ${org.id} has a service_provisioning_request_id ` +
        'but no external_identities row — data integrity violation, this should never happen'
    )
  }

  return { organizationId: org.id, userId: membership.userId, externalIdentityId: identity.id }
}

/**
 * Story 26.1 AC-1: the actual provisioning transaction — allocates a slug, creates the org, a
 * first (no-native-login) user, its owner membership, and the externalIdentities link row. Does
 * NOT itself handle the idempotency race (see provisionServiceOrganization, which wraps this and
 * resolves a lost race to the real winner) — a unique-violation here aborts the whole transaction,
 * by design, so the caller can cleanly retry a fresh read afterward.
 */
async function insertNewProvisioning(
  input: ProvisionServiceOrganizationRequest
): Promise<ProvisionServiceOrganizationResult> {
  return getDb().transaction(async (tx) => {
    const typedTx = tx as Tx
    const allocated = await allocateOrganizationSlug(typedTx, slugify(input.organizationName))

    const [org] = await typedTx
      .update(organizations)
      .set({
        name: input.organizationName,
        serviceProvisioningRequestId: input.requestId,
      })
      .where(eq(organizations.id, allocated.id))
      .returning({ id: organizations.id })
    if (!org) throw new Error('insertNewProvisioning: organization update returned no row')

    const passwordHash = await generateUnusablePasswordHash()
    const [user] = await typedTx
      .insert(users)
      .values({ email: `service-provisioned+${org.id}@invalid.projectvault`, passwordHash })
      .returning({ id: users.id })
    if (!user) throw new Error('insertNewProvisioning: user insert returned no row')

    await typedTx.execute(sql`SELECT set_config('app.current_org_id', ${org.id}, true)`)
    await typedTx.insert(orgMemberships).values({
      orgId: org.id,
      userId: user.id,
      role: 'owner',
      status: 'active',
    })

    const [identity] = await typedTx
      .insert(externalIdentities)
      .values({
        orgId: org.id,
        userId: user.id,
        providerName: SERVICE_PROVISIONING_PROVIDER_NAME,
        externalSubject: input.workosUserId,
      })
      .returning({ id: externalIdentities.id })
    if (!identity)
      throw new Error('insertNewProvisioning: external identity insert returned no row')

    return { organizationId: org.id, userId: user.id, externalIdentityId: identity.id }
  })
}

/**
 * Story 26.1 AC-1/AC-4: atomically creates a brand-new PV organization, a first user with an
 * unusable (no-native-login) password hash, an `owner` orgMemberships row, and a matching
 * externalIdentities link row (providerName: 'workos') — all in one transaction. Idempotent on
 * `input.requestId`: a repeated call with the same requestId returns the SAME result, backed by
 * `idx_organizations_service_provisioning_request_id` (migration 0083), never an
 * application-level check alone. Proven safe under genuine concurrency: two simultaneous callers
 * with the same requestId both pass the pre-check SELECT, both attempt the insert, and exactly one
 * wins the unique index — the loser's transaction aborts (Postgres 23505) and is resolved here to
 * the real winner's row via a fresh read, never surfaced as an error to the caller.
 */
export async function provisionServiceOrganization(
  input: ProvisionServiceOrganizationRequest
): Promise<ProvisionServiceOrganizationResult> {
  const existing = await getDb().transaction(async (tx) =>
    findExistingProvisioning(tx as Tx, input.requestId)
  )
  if (existing) return existing

  try {
    return await insertNewProvisioning(input)
  } catch (error) {
    if (isUniqueViolation(error, 'idx_organizations_service_provisioning_request_id')) {
      const winner = await getDb().transaction(async (tx) =>
        findExistingProvisioning(tx as Tx, input.requestId)
      )
      if (winner) return winner
    }
    throw error
  }
}

export class ServiceProvisioningForbiddenError extends AppError {
  constructor() {
    super(
      'service_provisioning_forbidden',
      'Service provisioning requires a valid service credential',
      403
    )
  }
}
