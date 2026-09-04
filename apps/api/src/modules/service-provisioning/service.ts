import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { externalIdentities, organizations, orgMemberships, users } from '@project-vault/db/schema'
import { AppError } from '../../lib/errors.js'
import { allocateOrganizationSlug, isUniqueViolation, slugify } from '../auth/service.js'
import { generateUnusablePasswordHash } from '../auth/password.js'
import { writeSystemAuditEntry } from '../audit/machine-entry.js'
import { AuditEvent } from '@project-vault/shared'
import type {
  BackfillCentralizemeOrgLinkRequest,
  ProvisionServiceOrganizationRequest,
  ProvisionServiceOrgMemberRequest,
} from './schema.js'

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
        // Story 30.2: only set when the caller sends it — CM's provisioning client doesn't send
        // it yet (deferred follow-up, see deferred-work.md), so this stays `undefined` (Drizzle
        // leaves the column untouched) for today's unmodified caller.
        centralizemeOrganizationId: input.centralizemeOrganizationId,
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

// Story 32.1 Decision 4/AC2: role validation is deliberately NOT delegated to zod's `.enum()` —
// an invalid value (including 'owner') must produce a distinct 400 invalid_role, never folded
// into AC9's generic 422 validation-error group. See schema.ts's comment on
// ProvisionServiceOrgMemberRequestSchema for the full rationale.
export const SERVICE_ORG_MEMBER_ROLES = ['admin', 'member', 'viewer'] as const
export type ServiceOrgMemberRole = (typeof SERVICE_ORG_MEMBER_ROLES)[number]

export type ProvisionServiceOrgMemberResult = {
  userId: string
  externalIdentityId: string
  /** true = first creation (route maps to 201); false = idempotent replay (route maps to 200). */
  created: boolean
}

export function invalidRoleError(): AppError {
  return new AppError('invalid_role', "role must be one of 'admin', 'member', 'viewer'", 400)
}

export function organizationNotFoundError(): AppError {
  return new AppError('organization_not_found', 'Organization not found', 404)
}

// Story 32.1 code-review finding (High): the org-existence check above only confirmed the
// organizationId is a real PV org — ANY real PV org, including a self-registered customer
// unrelated to CentralizeMe entirely. A leaked SERVICE_PROVISIONING_TOKEN could otherwise inject
// an admin-role member into any org in the system. Nestor's explicit decision after review:
// require organizations.centralizeme_organization_id to be non-null before allowing provisioning
// via this route — a materially larger blast radius than sibling Story 26.1's route (which only
// ever creates brand-new, empty orgs) justifies the stricter check, even though it means CM's
// real current caller (which may not yet send centralizemeOrganizationId on every org — Story
// 30.2 deferred follow-up) could get blocked until CM's own side is updated. See story Dev Notes
// for the 403-vs-404 status code rationale (distinct from Decision 4, which is about
// CM-membership/role trust, not PV-side org scope).
export function organizationNotCentralizemeManagedError(): AppError {
  return new AppError(
    'organization_not_centralizeme_managed',
    'Organization is not CentralizeMe-managed and cannot be provisioned via this route',
    403
  )
}

function validateRequestedRole(role: string | undefined): ServiceOrgMemberRole {
  if (role === undefined) return 'member'
  if (!(SERVICE_ORG_MEMBER_ROLES as readonly string[]).includes(role)) throw invalidRoleError()
  return role as ServiceOrgMemberRole
}

/**
 * Story 32.1 AC1/AC3/AC9: the actual per-member provisioning transaction — verifies the target
 * organization already exists (404 organization_not_found otherwise, before any write), creates a
 * new no-native-login-capable user, its orgMemberships row (role defaulting to 'member'), and the
 * matching externalIdentities row. Mirrors insertNewProvisioning above (26.1), scoped to an
 * existing org instead of a freshly-allocated one. A unique-violation on the
 * externalIdentities insert aborts the whole transaction, by design — the caller
 * (provisionServiceOrgMember) resolves that race via a fresh read afterward.
 *
 * Story 32.1 code-review finding: existence alone isn't enough — the org must also be
 * CentralizeMe-managed (organizations.centralizeme_organization_id non-null), or this throws 403
 * organizationNotCentralizemeManagedError (see that function's comment for the full rationale).
 * This check runs before the org-scoped identity/membership inserts and therefore also applies to
 * a would-be idempotent replay reaching this function (a repeat call only skips this path once an
 * externalIdentities row already exists, via the unique-violation catch below) — an accepted
 * consequence of the same fail-closed decision, not a separate one.
 */
async function insertNewOrgMember(
  organizationId: string,
  input: ProvisionServiceOrgMemberRequest,
  role: ServiceOrgMemberRole
): Promise<ProvisionServiceOrgMemberResult> {
  return getDb().transaction(async (tx) => {
    const typedTx = tx as Tx

    const [org] = await typedTx
      .select({
        id: organizations.id,
        centralizemeOrganizationId: organizations.centralizemeOrganizationId,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
    if (!org) throw organizationNotFoundError()
    if (org.centralizemeOrganizationId === null) throw organizationNotCentralizemeManagedError()

    const passwordHash = await generateUnusablePasswordHash()
    const [user] = await typedTx
      .insert(users)
      .values({ email: `service-provisioned+${randomUUID()}@invalid.projectvault`, passwordHash })
      .returning({ id: users.id })
    if (!user) throw new Error('insertNewOrgMember: user insert returned no row')

    await typedTx.execute(sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`)
    await typedTx.insert(orgMemberships).values({
      orgId: organizationId,
      userId: user.id,
      role,
      status: 'active',
    })

    const [identity] = await typedTx
      .insert(externalIdentities)
      .values({
        orgId: organizationId,
        userId: user.id,
        providerName: SERVICE_PROVISIONING_PROVIDER_NAME,
        externalSubject: input.workosUserId,
      })
      .returning({ id: externalIdentities.id })
    if (!identity) throw new Error('insertNewOrgMember: external identity insert returned no row')

    // Task 6/Security Audit Personas finding: the granted role is recorded explicitly so an
    // 'admin' grant via this route is reviewable later, not folded into an undifferentiated
    // "member provisioned" log line.
    await writeSystemAuditEntry(typedTx, {
      orgId: organizationId,
      eventType: AuditEvent.ORG_MEMBER_PROVISIONED,
      resourceId: user.id,
      resourceType: 'user',
      payload: { role, workosUserId: input.workosUserId, requestId: input.requestId },
    })

    return { userId: user.id, externalIdentityId: identity.id, created: true }
  })
}

/**
 * Story 32.1 AC5/AC8/AC12: resolves the idempotent-replay path — re-reads the existing
 * externalIdentities row for `(organizationId, 'workos', workosUserId)` and its linked
 * orgMemberships row (with `app.current_org_id` set first, RLS gotcha reused from
 * findExistingProvisioning above). If that membership was deactivated since the original
 * provisioning call, reactivates it in the same transaction (AC8) rather than silently returning
 * success while the member stays locked out.
 */
async function findExistingOrgMemberAndReactivate(
  organizationId: string,
  input: ProvisionServiceOrgMemberRequest
): Promise<ProvisionServiceOrgMemberResult> {
  const { workosUserId, requestId } = input
  return getDb().transaction(async (tx) => {
    const typedTx = tx as Tx
    await typedTx.execute(sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`)

    const [identity] = await typedTx
      .select({ id: externalIdentities.id, userId: externalIdentities.userId })
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.orgId, organizationId),
          eq(externalIdentities.providerName, SERVICE_PROVISIONING_PROVIDER_NAME),
          eq(externalIdentities.externalSubject, workosUserId)
        )
      )
      .limit(1)
    if (!identity) {
      throw new Error(
        'findExistingOrgMemberAndReactivate: unique violation but no matching external ' +
          'identity found — data integrity violation, this should never happen'
      )
    }

    const [membership] = await typedTx
      .select({ role: orgMemberships.role, status: orgMemberships.status })
      .from(orgMemberships)
      .where(
        and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.userId, identity.userId))
      )
      .limit(1)
    if (!membership) {
      throw new Error(
        'findExistingOrgMemberAndReactivate: external identity exists but no orgMemberships ' +
          'row — data integrity violation, this should never happen'
      )
    }

    if (membership.status === 'deactivated') {
      await typedTx
        .update(orgMemberships)
        .set({ status: 'active' })
        .where(
          and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.userId, identity.userId))
        )

      // Code-review finding (Story 32.1): mirror insertNewOrgMember's audit payload shape
      // (role + requestId) here too, so a reactivation's forensic trail can answer "what role
      // was this member reactivated with, and under what request?" — not just that it happened.
      await writeSystemAuditEntry(typedTx, {
        orgId: organizationId,
        eventType: AuditEvent.ORG_MEMBER_PROVISIONED,
        resourceId: identity.userId,
        resourceType: 'user',
        payload: { reactivated: true, role: membership.role, workosUserId, requestId },
      })
    }

    return { userId: identity.userId, externalIdentityId: identity.id, created: false }
  })
}

/**
 * Story 32.1 AC1/AC4/AC5/AC12: atomically creates a new PV user + orgMemberships row + matching
 * externalIdentities row on an EXISTING organization, for a trusted machine caller. Idempotent on
 * `(organizationId, 'workos', workosUserId)` — backed by the pre-existing
 * idx_external_identities_org_provider_subject unique index (Decision 2), never an
 * application-level check alone. The unique-violation catch checks the SPECIFIC index name
 * (AC12) — a different unique-constraint violation (e.g. an orgMemberships composite-PK
 * collision from an actual logic bug) surfaces as a 500 instead of being silently absorbed into
 * the idempotent "success" path.
 */
export async function provisionServiceOrgMember(
  organizationId: string,
  input: ProvisionServiceOrgMemberRequest
): Promise<ProvisionServiceOrgMemberResult> {
  const role = validateRequestedRole(input.role)

  try {
    return await insertNewOrgMember(organizationId, input, role)
  } catch (error) {
    if (isUniqueViolation(error, 'idx_external_identities_org_provider_subject')) {
      return findExistingOrgMemberAndReactivate(organizationId, input)
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

/**
 * Story 31.1 (DW-130) AC1.2/AC1.3/AC1.4: mirrors ServiceProvisioningForbiddenError exactly —
 * same shape/status for every failure mode (missing header, wrong token, unset env var), never
 * distinguishable which case occurred.
 */
export class ServiceRevocationForbiddenError extends AppError {
  constructor() {
    super(
      'service_revocation_forbidden',
      'Service revocation requires a valid service credential',
      403
    )
  }
}

/**
 * Story 31.1 AC3.11/AC3.12: zero rows match (no such CM org, or a real org with a still-null
 * centralizeme_organization_id per DW-153) — and a defensive fail-closed guard for the
 * structurally-impossible-today case of the unique index returning more than one row. Never
 * leaks whether the org exists in PV under a different/unset CM id.
 */
export function serviceOrgNotFound(): AppError {
  return new AppError('org_not_found', 'Organization not found', 404)
}

/**
 * Story 31.1 (DW-130) AC3.10: resolves the CM-supplied :centralizemeOrganizationId URL param to
 * PV's internal organizations.id via the existing partial unique index (migration 0088, Story
 * 30-2) — no new migration. `organizations` carries no RLS policy (it is the tenant root, not
 * tenant-scoped), so this is a plain, unscoped lookup — mirroring findExistingProvisioning's own
 * pre-org-context organizations SELECT above. Returns null on zero matches (AC3.11) and also on
 * more than one match (AC3.12) — the unique index makes multi-match structurally impossible today,
 * but this fails closed instead of picking the first row if a future migration ever weakens the
 * constraint.
 */
export async function resolveOrgByCentralizemeId(
  centralizemeOrganizationId: string
): Promise<string | null> {
  const rows = await getDb()
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.centralizemeOrganizationId, centralizemeOrganizationId))
    .limit(2)
  if (rows.length !== 1) return null
  return rows[0]?.id ?? null
}

// Story 33.1 AC6: a genuine, differing prior link — CM's own data error, never silently
// overwritten (see AC19's accepted-swapped-id-risk note for why PV cannot detect every CM-side
// mistake, only this one).
export function centralizemeLinkMismatchError(): AppError {
  return new AppError(
    'centralizeme_link_mismatch',
    'Organization is already linked to a different centralizemeOrganizationId',
    409
  )
}

// Story 33.1 AC7: the requested centralizemeOrganizationId already belongs to a DIFFERENT PV
// organization (would violate idx_organizations_centralizeme_organization_id) — distinct
// remediation from centralizemeLinkMismatchError above (AC6 is "this org already has a
// different link"; this is "that CM id belongs to someone else").
export function centralizemeIdAlreadyLinkedError(): AppError {
  return new AppError(
    'centralizeme_id_already_linked',
    'centralizemeOrganizationId is already linked to a different organization',
    409
  )
}

export type BackfillCentralizemeOrgLinkResult = {
  organizationId: string
  centralizemeOrganizationId: string
  alreadyLinked: boolean
  dryRun: boolean
}

type OrgLinkRow = { id: string; centralizemeOrganizationId: string | null }

/**
 * Story 33.1 Task 2: the shared check logic both the dry-run and real paths call, so they cannot
 * drift (AC8-10 must return exactly what the real call would). Given the current stored value:
 *  - exact match (AC18: case-sensitive, post-.trim() byte equality) -> returns `{ outcome: 'noop' }`
 *  - a different, non-null value -> throws centralizemeLinkMismatchError() (AC6)
 *  - null -> returns `{ outcome: 'proceed' }`, meaning the caller must still run the
 *    claimed-elsewhere check (AC7) before it may write.
 * Never queries or mutates anything itself — pure decision logic over an already-read row.
 */
function evaluateStoredLink(
  org: OrgLinkRow,
  input: BackfillCentralizemeOrgLinkRequest
): { outcome: 'noop' } | { outcome: 'proceed' } {
  if (org.centralizemeOrganizationId === null) return { outcome: 'proceed' }
  if (org.centralizemeOrganizationId === input.centralizemeOrganizationId) {
    return { outcome: 'noop' }
  }
  throw centralizemeLinkMismatchError()
}

/**
 * Story 33.1 AC7: fast-path pre-check for "this centralizemeOrganizationId is already claimed by
 * a DIFFERENT PV organization" — shared by both the dry-run and real paths. Always run against
 * `getDb()` directly (never inside the real path's row-locked transaction) is deliberately NOT
 * the case here: the real path passes its own `tx` so the check sees the same
 * transaction-consistent snapshot as the row lock it is holding.
 */
async function findDifferentOrgClaimingId(
  tx: Tx,
  organizationId: string,
  centralizemeOrganizationId: string
): Promise<boolean> {
  const [claimant] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.centralizemeOrganizationId, centralizemeOrganizationId),
        sql`${organizations.id} != ${organizationId}`
      )
    )
    .limit(1)
  return Boolean(claimant)
}

/**
 * Story 33.1 AC8/AC9: dry-run preview — runs every check the real call would (existence, exact-
 * match no-op, mismatch, claimed-elsewhere) but never writes, never takes the row lock (AC17 only
 * protects the real, mutating path), and never writes an audit entry (AC10). Documented as a
 * best-effort preview only (Decision 3) — a concurrent write between this read and a later real
 * call is possible and is resolved by the real call's own fail-closed/race-safe checks, not by
 * this function.
 */
async function backfillCentralizemeOrgLinkDryRun(
  organizationId: string,
  input: BackfillCentralizemeOrgLinkRequest
): Promise<BackfillCentralizemeOrgLinkResult> {
  const db = getDb()
  const [org] = await db
    .select({
      id: organizations.id,
      centralizemeOrganizationId: organizations.centralizemeOrganizationId,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  if (!org) throw organizationNotFoundError()

  const decision = evaluateStoredLink(org, input)
  if (decision.outcome === 'noop') {
    return {
      organizationId,
      centralizemeOrganizationId: input.centralizemeOrganizationId,
      alreadyLinked: true,
      dryRun: true,
    }
  }

  if (
    await findDifferentOrgClaimingId(
      db as unknown as Tx,
      organizationId,
      input.centralizemeOrganizationId
    )
  ) {
    throw centralizemeIdAlreadyLinkedError()
  }

  return {
    organizationId,
    centralizemeOrganizationId: input.centralizemeOrganizationId,
    alreadyLinked: false,
    dryRun: true,
  }
}

/**
 * Story 33.1 AC1/AC4/AC5/AC6/AC7/AC13/AC17: the real (mutating) backfill transaction. Row-locks
 * the target organization (`SELECT ... FOR UPDATE`) for the whole transaction to close the
 * same-organization concurrent-write race (AC17, distinct from AC7's different-org race): two
 * concurrent callers targeting the SAME :organizationId with two different
 * centralizemeOrganizationId values cannot both observe a `null` stored value and both write —
 * the second transaction blocks on the lock until the first commits, then re-reads the now-set
 * value and returns the same 409 centralizeme_link_mismatch (AC6) a sequential mismatch would.
 * The claimed-elsewhere fast-path check (AC7) runs inside this same locked transaction so it sees
 * a transaction-consistent snapshot; the UPDATE's own unique-violation catch (outside this
 * function, in backfillCentralizemeOrgLink) is the race-safe backstop for the different-org case
 * the fast-path SELECT cannot fully close.
 */
async function backfillCentralizemeOrgLinkReal(
  organizationId: string,
  input: BackfillCentralizemeOrgLinkRequest
): Promise<BackfillCentralizemeOrgLinkResult> {
  return getDb().transaction(async (tx) => {
    const typedTx = tx as Tx

    const [org] = await typedTx
      .select({
        id: organizations.id,
        centralizemeOrganizationId: organizations.centralizemeOrganizationId,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('update')
      .limit(1)
    if (!org) throw organizationNotFoundError()

    const decision = evaluateStoredLink(org, input)
    if (decision.outcome === 'noop') {
      return {
        organizationId,
        centralizemeOrganizationId: input.centralizemeOrganizationId,
        alreadyLinked: true,
        dryRun: false,
      }
    }

    if (
      await findDifferentOrgClaimingId(typedTx, organizationId, input.centralizemeOrganizationId)
    ) {
      throw centralizemeIdAlreadyLinkedError()
    }

    await typedTx
      .update(organizations)
      .set({ centralizemeOrganizationId: input.centralizemeOrganizationId })
      .where(eq(organizations.id, organizationId))

    // AC4: only a genuine, first-time link is audited — never the no-op (AC5) or dry-run (AC10)
    // branches, both of which return before this point.
    await writeSystemAuditEntry(typedTx, {
      orgId: organizationId,
      eventType: AuditEvent.ORG_CENTRALIZEME_LINK_BACKFILLED,
      resourceId: organizationId,
      resourceType: 'organization',
      payload: {
        centralizemeOrganizationId: input.centralizemeOrganizationId,
        requestId: input.requestId,
      },
    })

    return {
      organizationId,
      centralizemeOrganizationId: input.centralizemeOrganizationId,
      alreadyLinked: false,
      dryRun: false,
    }
  })
}

/**
 * Story 33.1 (DW-256) AC1-AC19: backfills `organizations.centralizeme_organization_id` for a
 * pre-existing organization whose value is still `null` (Decision 1-3) — set-if-null, idempotent
 * on an exact-match replay (AC5), fail-closed 409 on any mismatch (AC6) or an id claimed by a
 * different org (AC7), with an optional `dryRun` preview that never mutates (AC8-10). The
 * `isUniqueViolation` catch here checks the SPECIFIC index name (AC13) — the fast-path SELECT
 * inside backfillCentralizemeOrgLinkReal already catches the common case; this catch is the
 * race-safe backstop for the narrow window between that SELECT and the UPDATE, mirroring
 * 26.1/32.1's own catch-and-resolve convention exactly.
 */
export async function backfillCentralizemeOrgLink(
  organizationId: string,
  input: BackfillCentralizemeOrgLinkRequest
): Promise<BackfillCentralizemeOrgLinkResult> {
  if (input.dryRun === true) {
    return backfillCentralizemeOrgLinkDryRun(organizationId, input)
  }

  try {
    return await backfillCentralizemeOrgLinkReal(organizationId, input)
  } catch (error) {
    if (isUniqueViolation(error, 'idx_organizations_centralizeme_organization_id')) {
      throw centralizemeIdAlreadyLinkedError()
    }
    throw error
  }
}
