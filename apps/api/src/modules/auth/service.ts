import { createHmac, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import {
  auditLogEntries,
  orgMemberships,
  organizations,
  platformSecurityEvents,
  projectMemberships,
  projects,
  refreshTokens,
  revokedTokens,
  sessions,
  userIdentityTokens,
  users,
  type ProjectInvitation,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { findErasedRequestForEmailGlobally } from '../compliance/erasure-lookup.js'
import {
  claimInvitation,
  findInvitationByTokenHash,
  validateInvitationStatus,
} from '../invitations/lookup.js'
import { hashInvitationToken } from '../invitations/tokens.js'
import { setGracePeriodOnPrivilegedRole } from './grace-period.js'
import { recordFailedAuthAttempt } from './failed-auth.js'
import { createPendingMfaSession, type MfaChallengeResult } from './mfa-login.js'
import { normalizeEmail } from './normalize.js'
import { hashUserPassword, verifyUserPassword } from './password.js'
import { evictSessionActivityDebounce } from './session-activity.js'
import { generateRefreshToken, hashRefreshToken } from './tokens.js'
import { findUserWithIdentityByEmail } from './user-lookup.js'
import {
  cleanupExpiredSession,
  computeRevokedTokenExpiresAt,
  revokeSessionById,
} from './session-revoke.js'

const MAX_SLUG_ATTEMPTS = 5
const REFRESH_TOKEN_REVOKED = 'refresh_token_revoked'
const REFRESH_TOKEN_REVOKED_MESSAGE = 'Refresh token has been revoked'

export type RequestMeta = {
  ipAddress?: string | null
  userAgent?: string | null
}

export type AccessClaims = {
  sub: string
  orgId: string
  jti: string
  sessionVersion: number
}

export type TokenMaterial = {
  accessClaims: AccessClaims
  accessMaxAgeSec: number
  refreshOpaque?: string
  refreshMaxAgeSec: number
}
type RotatedTokenMaterial = TokenMaterial & { refreshOpaque: string }

export type RegisterInput = {
  email: string
  password: string
  orgName?: string
  invitationToken?: string
}

export type RegisterResult = {
  userId: string
  orgId: string
  email: string
  orgName: string
  role: 'owner' | 'member'
  invitedProject?: { projectId: string; projectName: string; role: 'admin' | 'member' | 'viewer' }
}

export type LoginInput = {
  email: string
  password: string
}

export type LoginResult = {
  userId: string
  orgId: string
  expiresAt: string
  tokens: TokenMaterial
}

export type RefreshResult = {
  expiresAt: string
  tokens: TokenMaterial
}

export type SessionSummary = {
  sessionId: string
  createdAt: string
  lastActiveAt: string
  ipAddress: string | null
  userAgent: string | null
  isCurrent: boolean
}

export type LoginSessionUser = {
  id: string
  identityTokenId: string | null
}

export function slugify(orgName: string): string {
  const slug = orgName
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || 'org'
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause
  if (cause?.code !== '23505') return false
  return constraint ? cause.constraint_name === constraint : true
}

function emailDomain(email: string): string {
  return email.split('@')[1] ?? ''
}

async function insertAuditEntry(
  tx: Tx,
  fields: {
    orgId: string
    actorTokenId: string | null
    actorType: 'human' | 'machine_user' | 'system'
    eventType: string
    payload: Record<string, unknown>
    ipAddress?: string | null
    userAgent?: string | null
  }
): Promise<void> {
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      orgId: fields.orgId,
      actorTokenId: fields.actorTokenId,
      actorType: fields.actorType,
      eventType: fields.eventType,
      payload: fields.payload,
      keyVersion,
    },
    getAuditKey()
  )

  await tx.insert(auditLogEntries).values({
    orgId: fields.orgId,
    actorTokenId: fields.actorTokenId,
    actorType: fields.actorType,
    eventType: fields.eventType,
    payload: fields.payload,
    keyVersion,
    hmac,
    ipAddress: fields.ipAddress ?? null,
    userAgent: fields.userAgent ?? null,
  })
}

function subjectHash(email: string): string {
  return createHmac('sha256', getAuditKey()).update(email).digest('hex')
}

async function insertPlatformSecurityEvent(
  tx: Tx,
  fields: {
    eventType: string
    subjectHash: string | null
    emailDomain: string | null
    payload: Record<string, unknown>
    ipAddress?: string | null
    userAgent?: string | null
  }
): Promise<void> {
  const keyVersion = await currentAuditKeyVersion(tx)
  const hmac = computeAuditHmac(
    {
      eventType: fields.eventType,
      subjectHash: fields.subjectHash,
      emailDomain: fields.emailDomain,
      payload: fields.payload,
      keyVersion,
    },
    getAuditKey()
  )

  await tx.insert(platformSecurityEvents).values({
    eventType: fields.eventType,
    subjectHash: fields.subjectHash,
    emailDomain: fields.emailDomain,
    payload: fields.payload,
    keyVersion,
    hmac,
    ipAddress: fields.ipAddress ?? null,
    userAgent: fields.userAgent ?? null,
  })
}

async function allocateOrganizationSlug(
  tx: Tx,
  baseSlug: string
): Promise<{ id: string; slug: string }> {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`
    try {
      const inserted = await tx
        .insert(organizations)
        .values({ name: '', slug })
        .returning({ id: organizations.id, slug: organizations.slug })
      const org = inserted[0]
      if (org) return org
    } catch (error) {
      if (!isUniqueViolation(error, 'organizations_slug_unique')) throw error
    }
  }
  throw new AppError('org_name_unavailable', 'Organization name could not be allocated', 409)
}

async function resolveRegistrationInvitation(
  input: RegisterInput,
  email: string
): Promise<ProjectInvitation | undefined> {
  if (!input.invitationToken) return undefined

  const found = await findInvitationByTokenHash(hashInvitationToken(input.invitationToken))
  const statusError = validateInvitationStatus(found)
  if (statusError) throw new AppError(statusError.code, statusError.message, statusError.statusCode)
  const invitation = found as ProjectInvitation

  if (normalizeEmail(invitation.email) !== email) {
    throw new AppError(
      'invitation_email_mismatch',
      'Registration email must match the invited email',
      422
    )
  }
  return invitation
}

async function resolveRegistrationOrg(
  tx: Tx,
  invitation: ProjectInvitation | undefined,
  orgName: string | undefined
): Promise<{ id: string; name: string }> {
  if (invitation) {
    // Re-set org context for this fresh transaction — the pre-transaction lookup above
    // ran its own withOrg() scans and doesn't carry context into this connection.
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${invitation.orgId}, true)`)
    const [orgRow] = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, invitation.orgId))
      .limit(1)
    if (!orgRow) throw new AppError('invitation_not_found', 'Invitation not found', 404)
    return orgRow
  }
  const allocated = await allocateOrganizationSlug(tx, slugify(orgName as string))
  await tx
    .update(organizations)
    .set({ name: (orgName as string).trim() })
    .where(eq(organizations.id, allocated.id))
  return { id: allocated.id, name: (orgName as string).trim() }
}

async function insertRegistrationMemberships(
  tx: Tx,
  org: { id: string },
  userId: string,
  invitation: ProjectInvitation | undefined
): Promise<void> {
  if (!invitation) {
    await tx.insert(orgMemberships).values({
      orgId: org.id,
      userId,
      role: 'owner',
      status: 'active',
      gracePeriodExpiresAt: setGracePeriodOnPrivilegedRole({ role: 'owner', mfaEnrolledAt: null }),
    })
    return
  }

  // On failure to claim, the caller's transaction rolls back the just-inserted `users` row too.
  const claimed = await claimInvitation(tx, invitation.id)
  if (!claimed) {
    throw new AppError(
      'invitation_already_accepted',
      'This invitation has already been accepted',
      409
    )
  }

  // D5: joining via invite always grants org role 'member', never the invited project role.
  await tx
    .insert(orgMemberships)
    .values({ orgId: org.id, userId, role: 'member', status: 'active' })
    .onConflictDoNothing()
  await tx
    .insert(projectMemberships)
    .values({
      orgId: org.id,
      projectId: invitation.projectId,
      userId,
      role: invitation.roleToAssign,
    })
    .onConflictDoNothing()
}

async function buildRegisterResult(
  tx: Tx,
  org: { id: string; name: string },
  user: { id: string; email: string },
  invitation: ProjectInvitation | undefined
): Promise<RegisterResult> {
  if (!invitation) {
    return {
      userId: user.id,
      orgId: org.id,
      email: user.email,
      orgName: org.name,
      role: 'owner' as const,
    }
  }
  const [project] = await tx
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, invitation.projectId))
    .limit(1)
  return {
    userId: user.id,
    orgId: org.id,
    email: user.email,
    orgName: org.name,
    role: 'member' as const,
    invitedProject: {
      projectId: invitation.projectId,
      projectName: project?.name ?? '',
      role: invitation.roleToAssign as 'admin' | 'member' | 'viewer',
    },
  }
}

/**
 * This is the single riskiest diff in Story 4.1 (D4) — it changes a Story 1.6 auth-critical
 * function to also support joining an existing org via invitation token instead of always
 * creating a new org. Adversarial review mandatory per Epic 1 retro P5.
 */
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const email = normalizeEmail(input.email)

  // Story 8.4 D6/AC-17B: once erasure execution overwrites users.email to
  // erased_<hash>@erased.invalid, the original address becomes free again against the unique
  // constraint — without this check, anyone could immediately self-register under an erased
  // identity's original email instead of being invited. Checked globally (not org-scoped): this
  // flow isn't reliably org-scoped (self-signup creates a brand new org), same reasoning as
  // AC-17's invitation-path check but via the admin connection (see erasure-lookup.ts).
  if (await findErasedRequestForEmailGlobally(email)) {
    throw new AppError('user_erased', 'This user has been erased and cannot register', 410)
  }

  const invitation = await resolveRegistrationInvitation(input, email)
  const passwordHash = await hashUserPassword(input.password)

  try {
    return await getDb().transaction(async (tx) => {
      const org = await resolveRegistrationOrg(tx as Tx, invitation, input.orgName)

      const insertedUsers = await tx
        .insert(users)
        .values({ email, passwordHash })
        .returning({ id: users.id, email: users.email })
      const user = insertedUsers[0]
      if (!user) throw new Error('registerUser: user insert returned no row')

      await tx.execute(sql`SELECT set_config('app.current_org_id', ${org.id}, true)`)
      await tx.execute(sql`SELECT set_config('app.auth_bootstrap_org_id', ${org.id}, true)`)

      await insertRegistrationMemberships(tx as Tx, org, user.id, invitation)

      const identityRows = await tx
        .insert(userIdentityTokens)
        .values({ userId: user.id, displayName: email })
        .returning({ id: userIdentityTokens.id })
      const identityToken = identityRows[0]
      if (!identityToken) throw new Error('registerUser: identity token insert returned no row')

      await insertAuditEntry(tx as Tx, {
        orgId: org.id,
        actorTokenId: identityToken.id,
        actorType: 'human',
        eventType: invitation ? AuditEvent.PROJECT_INVITATION_ACCEPTED : AuditEvent.USER_REGISTERED,
        payload: invitation
          ? { emailDomain: emailDomain(email), projectId: invitation.projectId }
          : { emailDomain: emailDomain(email) },
      })

      return buildRegisterResult(tx as Tx, org, user, invitation)
    })
  } catch (error) {
    if (isUniqueViolation(error, 'users_email_unique')) {
      await verifyUserPassword(input.password, env.AUTH_DUMMY_PASSWORD_HASH)
      throw new AppError('email_taken', 'An account with this email already exists', 409)
    }
    throw error
  }
}

async function recordLoginFailed(
  user: { id: string; identityTokenId: string | null; orgId: string | null } | null,
  email: string,
  meta: RequestMeta
): Promise<void> {
  try {
    if (!user?.orgId) {
      await getDb().transaction((tx) =>
        insertPlatformSecurityEvent(tx as Tx, {
          eventType: AuditEvent.LOGIN_FAILED,
          subjectHash: subjectHash(email),
          emailDomain: emailDomain(email),
          payload: { reason: user ? 'orphan_user' : 'unknown_subject' },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        })
      )
      return
    }
    await withOrg(user.orgId, async (tx) => {
      await insertAuditEntry(tx, {
        orgId: user.orgId as string,
        actorTokenId: user.identityTokenId,
        actorType: 'human',
        eventType: AuditEvent.LOGIN_FAILED,
        payload: { reason: 'invalid_credentials' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    })
  } catch (error) {
    process.stderr.write(
      `[auth.login_failed_audit_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

async function findLoginUser(email: string) {
  const userRows = await findUserWithIdentityByEmail(email)
  const user = userRows[0]
  if (!user) return []

  const orgRows = await getDb().select({ orgId: organizations.id }).from(organizations)
  const membershipRows = []
  for (const { orgId } of orgRows) {
    const memberships = await withOrg(orgId, (tx) =>
      tx
        .select({
          orgId: orgMemberships.orgId,
          membershipStatus: orgMemberships.status,
        })
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, user.id))
        .limit(1)
    )
    const membership = memberships[0]
    if (membership) {
      membershipRows.push({ ...user, ...membership })
    }
  }

  return membershipRows.length ? membershipRows : [{ ...user, orgId: null, membershipStatus: null }]
}

function invalidCredentials(): AppError {
  return new AppError('invalid_credentials', 'Invalid email or password', 401)
}

function failedLoginAuditSubject(
  user: Awaited<ReturnType<typeof findLoginUser>>[number] | undefined,
  rows: Awaited<ReturnType<typeof findLoginUser>>,
  activeOrgId: string | null | undefined
): { id: string; identityTokenId: string | null; orgId: string | null } | null {
  if (!user) return null
  return {
    id: user.id,
    identityTokenId: user.identityTokenId,
    orgId: activeOrgId ?? rows.find((row) => row.orgId)?.orgId ?? null,
  }
}

function buildTokenMaterial(userId: string, orgId: string, jti: string): RotatedTokenMaterial {
  return {
    accessClaims: { sub: userId, orgId, jti, sessionVersion: 1 },
    accessMaxAgeSec: env.JWT_ACCESS_TTL_SECONDS,
    refreshOpaque: generateRefreshToken(),
    refreshMaxAgeSec: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  }
}

async function verifyLoginPassword(
  input: LoginInput,
  user: Awaited<ReturnType<typeof findLoginUser>>[number] | undefined
) {
  const hash = user?.passwordHash ?? env.AUTH_DUMMY_PASSWORD_HASH
  try {
    return await verifyUserPassword(input.password, hash)
  } catch (error) {
    if (user) {
      process.stderr.write(
        `[auth.password_hash_corrupt] userId=${user.id} ${
          error instanceof Error ? error.message : String(error)
        }\n`
      )
    }
    return false
  }
}

export async function createLoginSessionInTx(
  tx: Tx,
  user: LoginSessionUser,
  orgId: string,
  meta: RequestMeta
): Promise<LoginResult> {
  await enforceMaxSessionsForUser(tx, user.id, orgId)
  const jti = randomUUID()
  const expiresAt = new Date(Date.now() + env.JWT_ACCESS_TTL_SECONDS * 1000)
  const tokens = buildTokenMaterial(user.id, orgId, jti)
  const sessionRows = await tx
    .insert(sessions)
    .values({
      userId: user.id,
      orgId,
      jti,
      sessionVersion: 1,
      expiresAt,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    })
    .returning({ id: sessions.id })
  const session = sessionRows[0]
  if (!session) throw new Error('loginUser: session insert returned no row')

  await tx.insert(refreshTokens).values({
    sessionId: session.id,
    orgId,
    tokenHash: hashRefreshToken(tokens.refreshOpaque),
    expiresAt: new Date(Date.now() + tokens.refreshMaxAgeSec * 1000),
  })

  await insertAuditEntry(tx, {
    orgId,
    actorTokenId: user.identityTokenId,
    actorType: 'human',
    eventType: AuditEvent.SESSION_CREATED,
    payload: {},
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  })

  return {
    userId: user.id,
    orgId,
    expiresAt: expiresAt.toISOString(),
    tokens,
  }
}

async function createLoginSession(
  user: NonNullable<Awaited<ReturnType<typeof findLoginUser>>[number]>,
  orgId: string,
  meta: RequestMeta
): Promise<LoginResult> {
  return withOrg(orgId, async (tx) => {
    return createLoginSessionInTx(tx, user, orgId, meta)
  })
}

function activeSessionPredicate({
  userId,
  orgId,
  idleCutoff,
}: {
  userId: string
  orgId: string
  idleCutoff?: Date
}): SQL | undefined {
  const predicates = [
    eq(sessions.userId, userId),
    eq(sessions.orgId, orgId),
    eq(refreshTokens.orgId, orgId),
    isNull(sessions.revokedAt),
    isNull(refreshTokens.revokedAt),
    gt(refreshTokens.expiresAt, new Date()),
  ]
  if (idleCutoff) predicates.push(gt(sessions.lastActiveAt, idleCutoff))
  return and(...predicates)
}

async function enforceMaxSessionsForUser(tx: Tx, userId: string, orgId: string): Promise<void> {
  if (env.MAX_SESSIONS_PER_USER === 0) return
  const rows = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(refreshTokens, eq(refreshTokens.sessionId, sessions.id))
    .where(activeSessionPredicate({ userId, orgId }))
    .orderBy(asc(sessions.lastActiveAt))

  const seen = new Set<string>()
  const activeSessionIds = rows
    .map((row) => row.id)
    .filter((id) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  const revokeCount = activeSessionIds.length - env.MAX_SESSIONS_PER_USER + 1
  if (revokeCount <= 0) return

  for (const sessionId of activeSessionIds.slice(0, revokeCount)) {
    await revokeSessionById(sessionId, {
      actorUserId: userId,
      scope: 'security',
      tx,
      expectedUserId: userId,
      expectedOrgId: orgId,
    })
  }
}

function normalizeLoginEmail(rawEmail: string, meta: RequestMeta): string {
  try {
    return normalizeEmail(rawEmail)
  } catch (error) {
    void recordFailedAuthAttempt({
      userId: null,
      ipAddress: meta.ipAddress ?? '0.0.0.0',
      attemptedEmail: rawEmail,
      reason: 'invalid_credentials',
    })
    throw error
  }
}

async function rejectInvalidLogin(
  email: string,
  meta: RequestMeta,
  user: Awaited<ReturnType<typeof findLoginUser>>[number] | undefined,
  rows: Awaited<ReturnType<typeof findLoginUser>>,
  activeOrgId: string | null | undefined
): Promise<never> {
  void recordFailedAuthAttempt({
    userId: user?.id ?? null,
    ipAddress: meta.ipAddress ?? '0.0.0.0',
    attemptedEmail: email,
    reason: 'invalid_credentials',
  })
  await recordLoginFailed(failedLoginAuditSubject(user, rows, activeOrgId), email, meta)
  throw invalidCredentials()
}

export async function loginUser(
  input: LoginInput,
  meta: RequestMeta = {}
): Promise<LoginResult | MfaChallengeResult> {
  const email = normalizeLoginEmail(input.email, meta)
  const rows = await findLoginUser(email)
  const user = rows[0]
  const activeMembership = rows.find((row) => row.membershipStatus === 'active' && row.orgId)
  const valid = await verifyLoginPassword(input, user)

  if (!user || !valid || !activeMembership?.orgId) {
    return rejectInvalidLogin(email, meta, user, rows, activeMembership?.orgId)
  }

  if (user.mfaEnrolledAt) {
    return createPendingMfaSession({ userId: user.id, orgId: activeMembership.orgId }, meta)
  }

  return createLoginSession(user, activeMembership.orgId, meta)
}

type RefreshRow = {
  id: string
  sessionId: string
  expiresAt: Date
  usedAt: Date | null
  revokedAt: Date | null
  newSessionId: string | null
  userId: string
  orgId: string
  jti: string
  sessionVersion: number
  sessionRevokedAt: Date | null
  lastActiveAt: Date
}

function revokedRefreshToken(): AppError {
  return new AppError(REFRESH_TOKEN_REVOKED, REFRESH_TOKEN_REVOKED_MESSAGE, 401)
}

async function findRefreshRow(tx: Tx, tokenHash: string): Promise<RefreshRow> {
  const tokenRows = await tx
    .select({
      id: refreshTokens.id,
      sessionId: refreshTokens.sessionId,
      orgId: refreshTokens.orgId,
      expiresAt: refreshTokens.expiresAt,
      usedAt: refreshTokens.usedAt,
      revokedAt: refreshTokens.revokedAt,
      newSessionId: refreshTokens.newSessionId,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .for('update')
    .limit(1)
  const token = tokenRows[0]
  if (!token) throw new AppError('refresh_token_invalid', 'Refresh token is invalid', 401)

  await tx.execute(sql`SELECT set_config('app.current_org_id', ${token.orgId}, true)`)
  const sessionRows = await tx
    .select({
      userId: sessions.userId,
      jti: sessions.jti,
      sessionVersion: sessions.sessionVersion,
      sessionRevokedAt: sessions.revokedAt,
      lastActiveAt: sessions.lastActiveAt,
    })
    .from(sessions)
    .where(and(eq(sessions.id, token.sessionId), eq(sessions.orgId, token.orgId)))
    .for('update')
    .limit(1)
  const session = sessionRows[0]
  if (!session) throw new AppError('refresh_token_invalid', 'Refresh token is invalid', 401)
  return { ...token, ...session }
}

async function handleGraceRefresh(tx: Tx, row: RefreshRow): Promise<RefreshResult> {
  const withinGrace =
    Date.now() - (row.usedAt?.getTime() ?? 0) <= env.REFRESH_GRACE_WINDOW_SECONDS * 1000
  if (!withinGrace || !row.newSessionId) throw revokedRefreshToken()
  const existing = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, row.newSessionId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1)
  const session = existing[0]
  if (!session?.jti) throw revokedRefreshToken()
  const tokens: TokenMaterial = {
    accessClaims: {
      sub: session.userId,
      orgId: session.orgId,
      jti: session.jti,
      sessionVersion: session.sessionVersion,
    },
    accessMaxAgeSec: env.JWT_ACCESS_TTL_SECONDS,
    refreshMaxAgeSec: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  }
  return {
    expiresAt: new Date(Date.now() + env.JWT_ACCESS_TTL_SECONDS * 1000).toISOString(),
    tokens,
  }
}

async function rotateRefreshToken(
  tx: Tx,
  row: RefreshRow,
  meta: RequestMeta,
  accessTokenExp?: Date
): Promise<RefreshResult> {
  const jti = randomUUID()
  const expiresAt = new Date(Date.now() + env.JWT_ACCESS_TTL_SECONDS * 1000)
  const tokens = buildTokenMaterial(row.userId, row.orgId, jti)
  const rotatedAt = new Date()
  const sessionRows = await tx
    .insert(sessions)
    .values({
      userId: row.userId,
      orgId: row.orgId,
      jti,
      sessionVersion: row.sessionVersion,
      expiresAt,
      lastActiveAt: rotatedAt,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    })
    .returning({ id: sessions.id })
  const newSession = sessionRows[0]
  if (!newSession) throw new Error('refreshSession: session insert returned no row')

  await tx
    .update(sessions)
    .set({
      revokedAt: rotatedAt,
      sessionVersion: row.sessionVersion + 1,
      updatedAt: rotatedAt,
    })
    .where(eq(sessions.id, row.sessionId))
  await tx
    .update(refreshTokens)
    .set({ revokedAt: rotatedAt })
    .where(
      and(
        eq(refreshTokens.sessionId, row.sessionId),
        isNull(refreshTokens.revokedAt),
        sql`${refreshTokens.id} <> ${row.id}`
      )
    )
  await tx
    .update(refreshTokens)
    .set({ usedAt: rotatedAt, newSessionId: newSession.id })
    .where(eq(refreshTokens.id, row.id))
  await tx.insert(refreshTokens).values({
    sessionId: newSession.id,
    orgId: row.orgId,
    tokenHash: hashRefreshToken(tokens.refreshOpaque),
    expiresAt: new Date(Date.now() + tokens.refreshMaxAgeSec * 1000),
  })
  await tx
    .insert(revokedTokens)
    .values({
      jti: row.jti,
      userId: row.userId,
      expiresAt: computeRevokedTokenExpiresAt({
        accessTokenExp,
        refreshTokenExpiresAt: row.expiresAt,
        now: rotatedAt,
      }),
    })
    .onConflictDoNothing()
  evictSessionActivityDebounce(row.sessionId)

  return { expiresAt: expiresAt.toISOString(), tokens }
}

export async function refreshSession(
  refreshOpaque: string,
  meta: RequestMeta = {},
  accessTokenExp?: Date
): Promise<RefreshResult> {
  const tokenHash = hashRefreshToken(refreshOpaque)
  const result = await getDb().transaction(async (tx) => {
    const row = await findRefreshRow(tx as Tx, tokenHash)
    if (row.usedAt) {
      return { expired: false as const, value: await handleGraceRefresh(tx as Tx, row) }
    }
    if (row.sessionRevokedAt) throw revokedRefreshToken()
    if (row.revokedAt) throw revokedRefreshToken()
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new AppError('refresh_token_expired', 'Refresh token has expired', 401)
    }
    const revoked = await (tx as Tx)
      .select({ jti: revokedTokens.jti })
      .from(revokedTokens)
      .where(eq(revokedTokens.jti, row.jti))
      .limit(1)
    if (revoked[0]) throw revokedRefreshToken()
    const idleMs = env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000
    if (Date.now() - row.lastActiveAt.getTime() > idleMs) {
      await cleanupExpiredSession(row.sessionId, { tx: tx as Tx, orgId: row.orgId })
      return { expired: true as const }
    }
    return {
      expired: false as const,
      value: await rotateRefreshToken(tx as Tx, row, meta, accessTokenExp),
    }
  })
  if (result.expired) {
    throw new AppError('session_expired', 'Session expired due to inactivity', 401)
  }
  return result.value
}

export async function listSessions(
  userId: string,
  orgId: string,
  currentJti: string,
  tx?: Tx
): Promise<SessionSummary[]> {
  const idleCutoff = new Date(Date.now() - env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000)
  const selectRows = (db: Tx) =>
    db
      .select({
        sessionId: sessions.id,
        jti: sessions.jti,
        createdAt: sessions.createdAt,
        lastActiveAt: sessions.lastActiveAt,
        ipAddress: sessions.ipAddress,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .innerJoin(refreshTokens, eq(refreshTokens.sessionId, sessions.id))
      .where(activeSessionPredicate({ userId, orgId, idleCutoff }))
      .orderBy(desc(sessions.lastActiveAt))
  const rows = tx ? await selectRows(tx) : await withOrg(orgId, selectRows)

  const seen = new Set<string>()
  return rows
    .filter((row) => {
      if (seen.has(row.sessionId)) return false
      seen.add(row.sessionId)
      return true
    })
    .map((row) => ({
      sessionId: row.sessionId,
      createdAt: row.createdAt.toISOString(),
      lastActiveAt: row.lastActiveAt.toISOString(),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      isCurrent: row.jti === currentJti,
    }))
}
