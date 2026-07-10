import { randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { count, desc, eq, sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import {
  accountRecoveryTokens,
  credentials,
  notificationQueue,
  organizations,
  orgMemberships,
  projects,
  systemSettings,
  users,
  type SystemSettings,
} from '@project-vault/db/schema'
import { encrypt, withSecret, type EncryptedValue } from '@project-vault/crypto'
import { PlatformAuditAction } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { getAdminDb } from '../../lib/db.js'
import { stripTrailingSlashes } from '../../lib/url.js'
import { getPrimaryKey } from '../vault/key-service.js'
import { resolveBackupDestination } from '../backup/config.js'
import { AppError } from '../../lib/errors.js'
import { writePlatformAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { allocateOrganizationSlug, isUniqueViolation, slugify } from '../auth/service.js'
import { normalizeEmail } from '../auth/normalize.js'
import { hashUserPassword } from '../auth/password.js'
import { generateRecoveryToken, hashRecoveryToken } from '../auth/recovery-tokens.js'
import type {
  CreateOrgRequest,
  CreateOrgResponse,
  OrgListResponse,
  ResourceUsageResponse,
  SystemSettingsResponse,
  SystemSettingsUpdate,
} from './schema.js'

/**
 * Story 9.2 D4 AC-3: a client that naively echoes back GET's masked `configured: true` shape
 * (instead of omitting the field) must not brick SMTP with a garbage literal password. Special-
 * cased as "field omitted", not a real password.
 */
export const SMTP_PASSWORD_CONFIGURED_SENTINEL = '[configured]'

/** Story 9.2 D3: advisory-lock key for the system_settings singleton row — serializes concurrent
 * PUT /admin/settings requests into a strict read-modify-write sequence (AC-22), same discipline
 * as Story 9.1's createAdminAlertIfNotActive per-alertType lock. */
const SETTINGS_LOCK_KEY = 'system_settings'

/**
 * Code review (post-9.2 implementation): AC-10's `maxOrgs` cap is documented (D3) as safe because
 * org creation is "a single, easy chokepoint" — but the original count-then-insert sequence in
 * createOrg() below had no locking, so two concurrent POST /admin/orgs calls near the limit could
 * both read the same (under-limit) count and both insert, exceeding maxOrgs — the same class of
 * concurrency bug this story's own AC-23/D7 point 3 fixed twice elsewhere (allocateOrganizationSlug's
 * and createOrg's own SAVEPOINT bugs). Serializes the count-check via the same
 * pg_advisory_xact_lock discipline already used for the system_settings singleton (AC-22).
 */
const ORG_COUNT_LOCK_KEY = 'org_count_check'

async function loadSystemSettingsRow(
  tx: Tx | ReturnType<typeof getDb>
): Promise<SystemSettings | undefined> {
  const [row] = await tx.select().from(systemSettings).where(eq(systemSettings.id, 1)).limit(1)
  return row
}

/** D3 precedence rule: DB override (non-null) wins, otherwise fall back to the env var / hardcoded
 * default. Single implementation, reused by resolveEffectiveSettings() (API response) and
 * resolveSmtpTransportConfig() (getEmailTransport()). */
function pick<T>(dbValue: T | null | undefined, envValue: T): T {
  return dbValue !== null && dbValue !== undefined ? dbValue : envValue
}

/** AC-3: three-way merge for a partial-update field — the just-provided update value wins, then
 * the existing stored row's value, then a hardcoded default. Centralizing the branching here (as
 * a plain, low-complexity helper) keeps every call site a single expression with no operators of
 * its own, so functions with many fields (mergedSmtpValues et al.) don't accumulate cyclomatic
 * complexity per-field. */
function coalesceUpdate<T>(
  updateValue: T | null | undefined,
  existingValue: T | null | undefined,
  fallback: T
): T {
  if (updateValue !== null && updateValue !== undefined) return updateValue
  if (existingValue !== null && existingValue !== undefined) return existingValue
  return fallback
}

function backupStorageType(): 'filesystem' | 's3' | null {
  const destination = resolveBackupDestination()
  return destination?.type ?? null
}

function effectiveSmtp(row: SystemSettings | undefined): SystemSettingsResponse['smtp'] {
  const host = pick(row?.smtpHost, env.SMTP_HOST ?? null)
  return {
    host,
    port: pick(row?.smtpPort, env.SMTP_PORT ?? null),
    user: pick(row?.smtpUser, env.SMTP_USER ?? null),
    from: pick(row?.smtpFrom, env.SMTP_FROM ?? null),
    configured: host !== null,
  }
}

function effectiveBackup(row: SystemSettings | undefined): SystemSettingsResponse['backup'] {
  return {
    schedule: pick(row?.backupScheduleOverride, env.BACKUP_SCHEDULE),
    retentionCount: pick(row?.backupRetentionCountOverride, env.BACKUP_RETENTION_COUNT),
    storageType: backupStorageType(),
  }
}

function effectiveInstancePolicy(
  row: SystemSettings | undefined
): SystemSettingsResponse['instancePolicy'] {
  return {
    maxOrgs: row?.maxOrgs ?? 10,
    maxUsersPerOrg: row?.maxUsersPerOrg ?? 50,
    sessionIdleTimeoutMinutes: pick(
      row?.sessionIdleTimeoutMinutesOverride,
      env.SESSION_IDLE_TIMEOUT_MINUTES
    ),
  }
}

/** D3/AC-2: builds the effective, API-facing settings snapshot (SMTP password never included,
 * only a `configured` boolean). Split into one helper per top-level section — keeps each
 * function's cyclomatic complexity within this repo's eslint threshold. */
export function computeEffectiveSettings(row: SystemSettings | undefined): SystemSettingsResponse {
  return {
    smtp: effectiveSmtp(row),
    backup: effectiveBackup(row),
    notifications: {
      defaultSlackWebhook: pick(row?.defaultSlackWebhookUrl, env.SLACK_WEBHOOK_URL ?? null),
    },
    instancePolicy: effectiveInstancePolicy(row),
  }
}

/** AC-2/AC-4: reads the current effective settings — never 404s, synthesizes defaults from env
 * vars when no system_settings row exists yet (AC-24: the migration never seeds one). */
export async function resolveEffectiveSettings(): Promise<SystemSettingsResponse> {
  const row = await loadSystemSettingsRow(getDb())
  return computeEffectiveSettings(row)
}

export type EffectiveSmtpTransportConfig = {
  host: string
  port: number
  secure: boolean
  user: string | null
  password: string | null
  from: string | null
}

/** D4: decrypts the stored SMTP password (DB override) or falls back to env.SMTP_PASS — split
 * out purely to keep resolveSmtpTransportConfig()'s cyclomatic complexity within threshold. */
async function resolveSmtpPassword(row: SystemSettings | undefined): Promise<string | null> {
  if (row?.smtpPassEncrypted) {
    return withSecret(row.smtpPassEncrypted as EncryptedValue, async (plaintext) =>
      plaintext.toString('utf8')
    )
  }
  return env.SMTP_PASS ?? null
}

function smtpTransportFieldsExceptPassword(
  row: SystemSettings | undefined
): Omit<EffectiveSmtpTransportConfig, 'host' | 'password'> {
  return {
    port: pick(row?.smtpPort, env.SMTP_PORT ?? 587),
    secure: pick(row?.smtpSecure, env.SMTP_SECURE ?? false),
    user: pick(row?.smtpUser, env.SMTP_USER ?? null),
    from: pick(row?.smtpFrom, env.SMTP_FROM ?? null),
  }
}

/**
 * D4: internal-only — resolves the *actual* SMTP transport config (decrypted password included)
 * for `notification-email.ts`'s `getEmailTransport()`. Never exposed via any API response.
 * Returns null when no host is configured anywhere (env or DB).
 */
export async function resolveSmtpTransportConfig(): Promise<EffectiveSmtpTransportConfig | null> {
  const row = await loadSystemSettingsRow(getDb())
  const host = pick(row?.smtpHost, env.SMTP_HOST ?? null)
  if (!host) return null

  return {
    host,
    ...smtpTransportFieldsExceptPassword(row),
    password: await resolveSmtpPassword(row),
  }
}

function isSentinelPassword(password: string | undefined): boolean {
  return password === SMTP_PASSWORD_CONFIGURED_SENTINEL
}

/** Returns true if any field that feeds `getEmailTransport()`'s cache was actually provided in
 * this update (D4/AC-6) — the sentinel-masked password does not count as a change. */
function smtpFieldsChanged(update: SystemSettingsUpdate): boolean {
  const smtp = update.smtp
  if (!smtp) return false
  const passwordChanged = smtp.password !== undefined && !isSentinelPassword(smtp.password)
  return (
    smtp.host !== undefined ||
    smtp.port !== undefined ||
    smtp.secure !== undefined ||
    smtp.user !== undefined ||
    smtp.from !== undefined ||
    passwordChanged
  )
}

export type UpsertSettingsResult = {
  effective: SystemSettingsResponse
  smtpChanged: boolean
}

/** D4: encrypts a freshly-provided SMTP password, or retains the existing encrypted value
 * unchanged (omitted field or the "[configured]" sentinel, AC-3). Split out purely to keep
 * upsertSystemSettings()'s transaction callback within this repo's complexity threshold. */
async function resolveUpsertSmtpPassEncrypted(
  update: SystemSettingsUpdate,
  existing: SystemSettings | undefined
): Promise<SystemSettings['smtpPassEncrypted']> {
  if (update.smtp?.password === undefined || isSentinelPassword(update.smtp.password)) {
    return existing?.smtpPassEncrypted ?? null
  }
  const key = getPrimaryKey()
  return encrypt(Buffer.from(update.smtp.password, 'utf8'), key)
}

function mergedSmtpValues(
  update: SystemSettingsUpdate,
  existing: SystemSettings | undefined,
  smtpPassEncrypted: SystemSettings['smtpPassEncrypted']
) {
  const smtp = update.smtp ?? {}
  return {
    smtpHost: coalesceUpdate(smtp.host, existing?.smtpHost, null),
    smtpPort: coalesceUpdate(smtp.port, existing?.smtpPort, null),
    smtpSecure: coalesceUpdate(smtp.secure, existing?.smtpSecure, null),
    smtpUser: coalesceUpdate(smtp.user, existing?.smtpUser, null),
    smtpPassEncrypted,
    smtpFrom: coalesceUpdate(smtp.from, existing?.smtpFrom, null),
  }
}

function mergedBackupAndNotificationValues(
  update: SystemSettingsUpdate,
  existing: SystemSettings | undefined
) {
  return {
    backupScheduleOverride: coalesceUpdate(
      update.backup?.scheduleOverride,
      existing?.backupScheduleOverride,
      null
    ),
    backupRetentionCountOverride: coalesceUpdate(
      update.backup?.retentionCountOverride,
      existing?.backupRetentionCountOverride,
      null
    ),
    defaultSlackWebhookUrl: coalesceUpdate(
      update.notifications?.defaultSlackWebhookUrl,
      existing?.defaultSlackWebhookUrl,
      null
    ),
  }
}

function mergedInstancePolicyValues(
  update: SystemSettingsUpdate,
  existing: SystemSettings | undefined
) {
  return {
    maxOrgs: coalesceUpdate(update.instancePolicy?.maxOrgs, existing?.maxOrgs, 10),
    maxUsersPerOrg: coalesceUpdate(
      update.instancePolicy?.maxUsersPerOrg,
      existing?.maxUsersPerOrg,
      50
    ),
    sessionIdleTimeoutMinutesOverride: coalesceUpdate(
      update.instancePolicy?.sessionIdleTimeoutMinutes,
      existing?.sessionIdleTimeoutMinutesOverride,
      null
    ),
  }
}

/** Merges a partial update over the existing row (or hardcoded defaults) — delegates each
 * section to its own helper so no single function's cyclomatic complexity crosses threshold. */
function mergedSettingsValues(
  update: SystemSettingsUpdate,
  existing: SystemSettings | undefined,
  smtpPassEncrypted: SystemSettings['smtpPassEncrypted'],
  updatedByUserId: string
) {
  return {
    id: 1 as const,
    ...mergedSmtpValues(update, existing, smtpPassEncrypted),
    ...mergedBackupAndNotificationValues(update, existing),
    ...mergedInstancePolicyValues(update, existing),
    updatedAt: new Date(),
    updatedByUserId,
  }
}

/**
 * D3/AC-3/AC-22: partial update — only provided fields are written; the singleton row is
 * read-modify-written inside a single transaction, serialized by an advisory lock keyed on the
 * (constant) row identity so two concurrent PUTs with non-overlapping field sets never clobber
 * each other (AC-22's "lost update" regression guard).
 *
 * Story 9.4 AC-8: also writes a `platform_audit_events` row (`settings.updated`) in this SAME
 * transaction — but only when at least one field was actually provided (AC-8 edge case: an empty
 * `PUT {}` no-op must not write a row with an empty `fieldsChanged: []`). `fieldsChanged` reuses
 * the exact same `Object.keys(update)` computation the route's operational log already uses
 * (top-level section names only, e.g. `'smtp'` not `'smtp.host'` — matches the shipped 9.2
 * precedent, not the illustrative dotted-path examples in this story's own AC text).
 */
export async function upsertSystemSettings(
  update: SystemSettingsUpdate,
  updatedByUserId: string,
  request?: FastifyRequest
): Promise<UpsertSettingsResult> {
  const smtpChanged = smtpFieldsChanged(update)
  const fieldsChanged = Object.keys(update)

  const effective = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SETTINGS_LOCK_KEY}))`)
    const existing = await loadSystemSettingsRow(tx)
    const smtpPassEncrypted = await resolveUpsertSmtpPassEncrypted(update, existing)
    const values = mergedSettingsValues(update, existing, smtpPassEncrypted, updatedByUserId)

    await tx
      .insert(systemSettings)
      .values(values)
      .onConflictDoUpdate({ target: systemSettings.id, set: values })

    if (fieldsChanged.length > 0) {
      await writePlatformAuditEntryOrFailClosed(tx, {
        operatorId: updatedByUserId,
        actionType: PlatformAuditAction.SETTINGS_UPDATED,
        payload: { fieldsChanged },
        ...(request ? { request } : {}),
      })
    }

    return computeEffectiveSettings(await loadSystemSettingsRow(tx))
  })

  return { effective, smtpChanged }
}

// ================================================================================================
// Multi-org provisioning (D6, D7, AC-8 through AC-11, AC-23)
// ================================================================================================

const NEW_ORG_OWNER_TOKEN_TTL_MS = 72 * 60 * 60 * 1000 // D7: matches Story 4.1's invitation TTL.

export class OrgLimitReachedError extends AppError {
  constructor(limit: number) {
    super(
      'org_limit_reached',
      `This instance has reached its configured limit of ${limit} organizations. Increase instancePolicy.maxOrgs via PUT /admin/settings to provision more.`,
      422
    )
  }
}

export class OwnerAccountDeactivatedError extends AppError {
  constructor() {
    super(
      'owner_account_deactivated',
      'The specified owner account is deactivated. Reactivate it first or choose a different owner.',
      409
    )
  }
}

/** D7 point 4: same discipline as generateSentinelPasswordHash() (compliance/erasure-service.ts)
 * — a freshly-generated, per-user random, non-functional password hash, never a fixed shared
 * constant. */
async function generateUnusablePasswordHash(): Promise<string> {
  return hashUserPassword(randomBytes(32).toString('hex'))
}

/** D7 point 4: enqueues the "set your initial password" email via the same notification_queue
 * mechanism/template `enqueueRecoveryEmail` (auth/recovery.ts) uses for admin-initiated recovery
 * links — reimplemented at this call site (rather than calling the private helper directly)
 * because the token TTL here is 72h (D7), not recovery.ts's 15-minute self-service TTL, and the
 * email must route through the *new* org's notification context (the new owner has no other org
 * membership yet), not the platform operator's own org. */
async function issueNewOwnerRecoveryLink(
  tx: Tx,
  input: {
    newOrgId: string
    newUserId: string
    recipientEmail: string
    initiatorOrgId: string | null
  }
): Promise<void> {
  const opaqueToken = generateRecoveryToken()
  const expiresAt = new Date(Date.now() + NEW_ORG_OWNER_TOKEN_TTL_MS)
  await tx.insert(accountRecoveryTokens).values({
    userId: input.newUserId,
    tokenHash: hashRecoveryToken(opaqueToken),
    initiatedBy: 'admin',
    initiatorOrgId: input.initiatorOrgId,
    expiresAt,
  })

  await tx.execute(sql`SELECT set_config('app.current_org_id', ${input.newOrgId}, true)`)
  const recoveryUrl = `${stripTrailingSlashes(env.WEB_BASE_URL)}/recovery/${opaqueToken}`
  await tx.insert(notificationQueue).values({
    orgId: input.newOrgId,
    recipientUserId: null,
    recipientEmail: input.recipientEmail,
    channel: 'email',
    templateId: 'auth.recovery_link_sent',
    payload: { recoveryUrl, initiatorEmail: null },
    status: 'pending',
  })
}

async function currentOrgCount(tx: Tx): Promise<number> {
  const [row] = await tx.select({ c: count() }).from(organizations)
  return Number(row?.c ?? 0)
}

async function insertOwnerMembership(tx: Tx, orgId: string, userId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
  await tx.insert(orgMemberships).values({ orgId, userId, role: 'owner', status: 'active' })
}

/** D7: is this existing user "deactivated" instance-wide — i.e. every org_membership row they
 * hold (there is always at least one for a real registered user) is status='deactivated', so
 * they have no active membership anywhere on the instance. Granting them ownership of a brand
 * new org would be an implicit, silent reactivation — AC-9's negative example forbids this. */
async function isUserDeactivatedEverywhere(userId: string): Promise<boolean> {
  const rows = await getAdminDb()
    .select({ status: orgMemberships.status })
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, userId))
  if (rows.length === 0) return false
  return rows.every((r) => r.status === 'deactivated')
}

export type CreateOrgOptions = {
  /** The operator's own org id — only used for the invited-owner recovery link's audit context. */
  operatorInitiatorOrgId: string | null
  /** Story 9.4 AC-8: the platform operator performing this action — recorded as
   * `platform_audit_events.operator_id`. */
  operatorUserId: string
  request?: FastifyRequest
}

/**
 * D7/AC-8/AC-9/AC-10/AC-23: creates a new organization, provisioning its owner via one of two
 * paths (existing user vs. brand-new invited user). Retries once as "existing user found" if a
 * concurrent request wins the users.email unique-violation race (AC-23) — the org this call is
 * provisioning still succeeds, with the now-existing user as its owner.
 *
 * Story 9.4 AC-8: writes a `platform_audit_events` row (`org.created`) in this SAME transaction —
 * a single-transaction operation, unlike backup/restore (AC-7), so the retrofit is a direct
 * addition right before each of this function's three return points, not a separate follow-up
 * write.
 */
export async function createOrg(
  input: CreateOrgRequest,
  options: CreateOrgOptions
): Promise<CreateOrgResponse> {
  const email = normalizeEmail(input.ownerEmail)
  const { operatorInitiatorOrgId, operatorUserId, request } = options

  async function finalizeOrgCreation(
    tx: Tx,
    result: CreateOrgResponse
  ): Promise<CreateOrgResponse> {
    await writePlatformAuditEntryOrFailClosed(tx, {
      operatorId: operatorUserId,
      actionType: PlatformAuditAction.ORG_CREATED,
      targetOrgId: result.id,
      targetUserId: result.ownerUserId,
      payload: { name: result.name, ownerAccountAction: result.ownerAccountAction },
      ...(request ? { request } : {}),
    })
    return result
  }

  return getDb().transaction(async (tx) => {
    // Code review fix: serializes the count-check-then-insert sequence so two concurrent
    // createOrg() calls near the limit cannot both observe an under-limit count and both insert
    // (AC-10's cap must be hard-enforced, not merely "usually" enforced).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ORG_COUNT_LOCK_KEY}))`)
    const effective = computeEffectiveSettings(await loadSystemSettingsRow(tx))
    const orgCount = await currentOrgCount(tx)
    if (orgCount >= effective.instancePolicy.maxOrgs) {
      throw new OrgLimitReachedError(effective.instancePolicy.maxOrgs)
    }

    const allocated = await allocateOrganizationSlug(tx, slugify(input.name))
    await tx
      .update(organizations)
      .set({ name: input.name })
      .where(eq(organizations.id, allocated.id))

    const [existingUser] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (existingUser) {
      if (await isUserDeactivatedEverywhere(existingUser.id)) {
        throw new OwnerAccountDeactivatedError()
      }
      await insertOwnerMembership(tx, allocated.id, existingUser.id)
      return finalizeOrgCreation(tx, {
        id: allocated.id,
        name: input.name,
        slug: allocated.slug,
        ownerAccountAction: 'existing_user_added' as const,
        ownerUserId: existingUser.id,
      })
    }

    try {
      // AC-23: the users.email insert races against a concurrent createOrg() call provisioning
      // the same brand-new ownerEmail. Runs in its own SAVEPOINT (tx.transaction() nested inside
      // an existing transaction becomes a real SAVEPOINT) so a unique-violation here rolls back
      // only this inner attempt, not the outer transaction that already holds the newly-allocated
      // org row — without this, Postgres 25P02 ("current transaction is aborted") would poison
      // every statement in the fallback path below, including the org this call is provisioning.
      const newUser = await tx.transaction(async (savepointTx) => {
        const typedTx = savepointTx as Tx
        const passwordHash = await generateUnusablePasswordHash()
        const [inserted] = await typedTx
          .insert(users)
          .values({ email, passwordHash, isPlatformOperator: false })
          .returning({ id: users.id })
        if (!inserted) throw new Error('createOrg: user insert returned no row')
        return inserted
      })

      await insertOwnerMembership(tx, allocated.id, newUser.id)
      await issueNewOwnerRecoveryLink(tx, {
        newOrgId: allocated.id,
        newUserId: newUser.id,
        recipientEmail: email,
        initiatorOrgId: operatorInitiatorOrgId,
      })

      return finalizeOrgCreation(tx, {
        id: allocated.id,
        name: input.name,
        slug: allocated.slug,
        ownerAccountAction: 'invited_new_user' as const,
        ownerUserId: newUser.id,
      })
    } catch (error) {
      // AC-23: lost the users.email unique-violation race to a concurrent request — the other
      // transaction's user now exists; re-query and proceed as "existing user found" rather than
      // failing this request outright (the org this call is provisioning still gets created).
      if (!isUniqueViolation(error, 'users_email_unique')) throw error
      const [racedUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      if (!racedUser) throw error
      await insertOwnerMembership(tx, allocated.id, racedUser.id)
      return finalizeOrgCreation(tx, {
        id: allocated.id,
        name: input.name,
        slug: allocated.slug,
        ownerAccountAction: 'existing_user_added' as const,
        ownerUserId: racedUser.id,
      })
    }
  })
}

/** D6: write-without-read is unusable — this endpoint is an addition beyond epics.md's literal
 * scope, justified in the story's D6. Uses the admin (RLS-bypassing) connection because
 * memberCount spans every org, and org_memberships is org-scoped/RLS-protected. */
export async function listOrgs(): Promise<OrgListResponse> {
  const rows = await getAdminDb()
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      createdAt: organizations.createdAt,
      memberCount: count(orgMemberships.userId),
    })
    .from(organizations)
    .leftJoin(orgMemberships, eq(orgMemberships.orgId, organizations.id))
    .groupBy(organizations.id)
    .orderBy(desc(organizations.createdAt))

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.createdAt.toISOString(),
      memberCount: Number(row.memberCount),
    })),
  }
}

// ================================================================================================
// Resource usage (AC-12 through AC-14)
// ================================================================================================

/**
 * AC-12: cross-org aggregate resource usage against instancePolicy limits. Uses the admin
 * (RLS-bypassing) connection throughout — this is the one endpoint whose entire purpose is
 * cross-org visibility for the platform operator, same justification as listOrgs()/D6.
 */
export async function resolveResourceUsage(): Promise<ResourceUsageResponse> {
  const admin = getAdminDb()
  const effective = await resolveEffectiveSettings()

  const [orgCountRow] = await admin.select({ c: count() }).from(organizations)
  const orgsCurrent = Number(orgCountRow?.c ?? 0)

  const orgRows = await admin.select({ id: organizations.id }).from(organizations)
  const usersPerOrgRows = await admin
    .select({ orgId: orgMemberships.orgId, c: count() })
    .from(orgMemberships)
    .where(eq(orgMemberships.status, 'active'))
    .groupBy(orgMemberships.orgId)
  const usersPerOrgMap = new Map(usersPerOrgRows.map((r) => [r.orgId, Number(r.c)]))
  const usersPerOrg = orgRows.map((org) => ({
    orgId: org.id,
    current: usersPerOrgMap.get(org.id) ?? 0,
    limit: effective.instancePolicy.maxUsersPerOrg,
  }))

  const secretsRows = await admin
    .select({ projectId: credentials.projectId, orgId: projects.orgId, c: count() })
    .from(credentials)
    .innerJoin(projects, eq(projects.id, credentials.projectId))
    .groupBy(credentials.projectId, projects.orgId)
  const secretsPerProject = secretsRows.map((r) => ({
    projectId: r.projectId,
    orgId: r.orgId,
    current: Number(r.c),
  }))

  const [auditCountRow] = await admin.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM audit_log_entries`
  )
  const auditLogEntriesCurrent = Number(auditCountRow?.count ?? 0)

  const [dbSizeRow] = await admin.execute<{ size: string }>(
    sql`SELECT pg_database_size(current_database())::text AS size`
  )
  const storageBytesCurrent = Number(dbSizeRow?.size ?? 0)

  const [auditBytesRow] = await admin.execute<{ size: string }>(
    sql`SELECT pg_total_relation_size('audit_log_entries')::text AS size`
  )
  const auditLogStorageCurrentBytes = Number(auditBytesRow?.size ?? 0)
  const auditLogStorageLimitBytes = env.AUDIT_LOG_STORAGE_LIMIT_GB * 1024 ** 3

  return {
    orgs: { current: orgsCurrent, limit: effective.instancePolicy.maxOrgs },
    usersPerOrg,
    secretsPerProject,
    auditLogEntries: { current: auditLogEntriesCurrent, limit: null },
    storageBytes: { current: storageBytesCurrent, limit: null },
    auditLogStorage: {
      currentBytes: auditLogStorageCurrentBytes,
      limitBytes: auditLogStorageLimitBytes,
      utilizationPct: auditLogStorageLimitBytes
        ? Math.round((auditLogStorageCurrentBytes / auditLogStorageLimitBytes) * 10000) / 100
        : 0,
    },
  }
}
