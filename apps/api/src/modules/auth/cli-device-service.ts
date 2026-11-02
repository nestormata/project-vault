import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { cliDeviceGrants, sessions, users } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { AppError } from '../../lib/errors.js'
import { isOrgMember } from '../../lib/org-membership.js'
import { resolveActiveOrgRoleInTx } from '../../plugins/authenticate.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import { verifyConfirmedLoginTotp } from './mfa.js'
import {
  createLoginSessionInTx,
  isUniqueViolation,
  type LoginResult,
  type RequestMeta,
} from './service.js'
import {
  issueUserSessionInTx,
  recordOrgCredential,
  type IssuedUserSession,
} from './user-session.js'
import {
  CLI_DEVICE_MAX_INTERVAL_SECONDS,
  CLI_DEVICE_POLL_INTERVAL_SECONDS,
  CLI_DEVICE_SLOW_DOWN_STEP_SECONDS,
  CLI_DEVICE_STEP_UP_FAILURE_LIMIT,
  CLI_DEVICE_TTL_SECONDS,
  CLI_ORG_CREDENTIAL_TTL_SECONDS,
  deviceCodeHashesEqual,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  hashUserCode,
} from './cli-device-codes.js'

type GrantRow = typeof cliDeviceGrants.$inferSelect

export type DeviceGrantCreated = {
  deviceCode: string
  userCode: string
  expiresIn: number
  interval: number
}

export type DevicePollResult =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'session'; session: IssuedUserSession }

export type DeviceDecision =
  | { kind: 'approved'; expiresIn: number }
  | { kind: 'denied' }
  | { kind: 'invalid' }
  | { kind: 'step_up_required' }
  | { kind: 'enrollment_required' }

type Approver = { userId: string; orgId: string; sessionId: string }

function expiresInOf(grant: GrantRow, now: Date): number {
  return Math.max(0, Math.ceil((grant.expiresAt.getTime() - now.getTime()) / 1000))
}

function isExpired(grant: GrantRow, now: Date): boolean {
  return grant.expiresAt.getTime() <= now.getTime()
}

function polledTooSoon(grant: GrantRow, now: Date): boolean {
  if (!grant.lastPolledAt) return false
  return now.getTime() - grant.lastPolledAt.getTime() < grant.intervalSeconds * 1000
}

async function setOrgContext(tx: Tx, orgId: string, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.current_org_id', ${orgId}, true),
             set_config('app.current_user_id', ${userId}, true)`
  )
}

async function writeGrantAudit(
  tx: Tx,
  orgId: string,
  userId: string,
  eventType: string,
  grantId: string,
  meta: RequestMeta
): Promise<void> {
  await writeHumanAuditEntry(tx, {
    orgId,
    actorTokenId: await firstActorTokenIdForUser(tx, userId),
    eventType,
    payload: { grantId },
    meta,
  })
}

async function insertGrant(
  tx: Tx,
  deviceCode: string,
  userCode: string,
  clientName: string | null,
  now: Date
): Promise<void> {
  const expiresAt = new Date(now.getTime() + CLI_DEVICE_TTL_SECONDS * 1000)
  await tx.insert(cliDeviceGrants).values({
    deviceCodeHash: hashDeviceCode(deviceCode),
    userCodeHash: hashUserCode(userCode),
    status: 'pending',
    expiresAt,
    intervalSeconds: CLI_DEVICE_POLL_INTERVAL_SECONDS,
    clientName,
  })
}

export async function createDeviceGrant(
  clientName: string | null,
  now = new Date()
): Promise<DeviceGrantCreated> {
  const deviceCode = generateDeviceCode()
  const userCode = generateUserCode()
  try {
    await getDb().transaction(async (tx) => {
      await insertGrant(tx as Tx, deviceCode, userCode, clientName, now)
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const retryDevice = generateDeviceCode()
    const retryUser = generateUserCode()
    await getDb().transaction(async (tx) => {
      await insertGrant(tx as Tx, retryDevice, retryUser, clientName, now)
    })
    return {
      deviceCode: retryDevice,
      userCode: retryUser,
      expiresIn: CLI_DEVICE_TTL_SECONDS,
      interval: CLI_DEVICE_POLL_INTERVAL_SECONDS,
    }
  }
  return {
    deviceCode,
    userCode,
    expiresIn: CLI_DEVICE_TTL_SECONDS,
    interval: CLI_DEVICE_POLL_INTERVAL_SECONDS,
  }
}

async function lockGrantByUserCode(tx: Tx, normalized: string): Promise<GrantRow | undefined> {
  const computed = hashUserCode(normalized)
  const rows = await tx
    .select()
    .from(cliDeviceGrants)
    .where(eq(cliDeviceGrants.userCodeHash, computed))
    .for('update')
    .limit(1)
  const grant = rows[0]
  const matches = deviceCodeHashesEqual(grant?.userCodeHash, computed)
  return grant && matches ? grant : undefined
}

async function operatorNeedsStepUp(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ isPlatformOperator: users.isPlatformOperator })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.isPlatformOperator === true
}

async function applyStepUp(
  tx: Tx,
  grant: GrantRow,
  userId: string,
  totpCode: string | undefined,
  now: Date
): Promise<DeviceDecision | null> {
  const verdict = await verifyConfirmedLoginTotp(tx, userId, totpCode ?? '')
  if (verdict === 'no_enrollment') return { kind: 'enrollment_required' }
  if (verdict === 'valid') return null
  const failures = grant.stepUpFailures + 1
  const locked = failures >= CLI_DEVICE_STEP_UP_FAILURE_LIMIT
  await tx
    .update(cliDeviceGrants)
    .set(
      locked
        ? { stepUpFailures: failures, status: 'denied', deniedAt: now }
        : { stepUpFailures: failures }
    )
    .where(eq(cliDeviceGrants.id, grant.id))
  return { kind: 'step_up_required' }
}

export async function decideDeviceGrant(
  approver: Approver,
  normalizedUserCode: string,
  decision: 'approve' | 'deny',
  totpCode: string | undefined,
  meta: RequestMeta,
  tx: Tx,
  now = new Date()
): Promise<DeviceDecision> {
  await setOrgContext(tx, approver.orgId, approver.userId)
  const grant = await lockGrantByUserCode(tx, normalizedUserCode)
  if (!grant || grant.status !== 'pending' || isExpired(grant, now)) return { kind: 'invalid' }
  if (decision === 'deny') {
    await tx
      .update(cliDeviceGrants)
      .set({ status: 'denied', deniedAt: now, userId: approver.userId, orgId: approver.orgId })
      .where(eq(cliDeviceGrants.id, grant.id))
    await writeGrantAudit(
      tx,
      approver.orgId,
      approver.userId,
      AuditEvent.CLI_DEVICE_LOGIN_DENIED,
      grant.id,
      meta
    )
    return { kind: 'denied' }
  }
  if (await operatorNeedsStepUp(tx, approver.userId)) {
    const refused = await applyStepUp(tx, grant, approver.userId, totpCode, now)
    if (refused) return refused
  }
  await tx
    .update(cliDeviceGrants)
    .set({
      status: 'approved',
      approvedAt: now,
      userId: approver.userId,
      orgId: approver.orgId,
      approverSessionId: approver.sessionId,
    })
    .where(eq(cliDeviceGrants.id, grant.id))
  await writeGrantAudit(
    tx,
    approver.orgId,
    approver.userId,
    AuditEvent.CLI_DEVICE_LOGIN_APPROVED,
    grant.id,
    meta
  )
  return { kind: 'approved', expiresIn: expiresInOf(grant, now) }
}

async function approverSessionLive(tx: Tx, grant: GrantRow): Promise<boolean> {
  if (!grant.approverSessionId || !grant.orgId || !grant.userId) return false
  await setOrgContext(tx, grant.orgId, grant.userId)
  const rows = await tx
    .select({ revokedAt: sessions.revokedAt })
    .from(sessions)
    .where(eq(sessions.id, grant.approverSessionId))
    .limit(1)
  return Boolean(rows[0] && rows[0].revokedAt === null)
}

async function markRevoked(tx: Tx, grant: GrantRow, meta: RequestMeta, now: Date): Promise<void> {
  await tx
    .update(cliDeviceGrants)
    .set({ status: 'revoked', revokedAt: now })
    .where(eq(cliDeviceGrants.id, grant.id))
  if (grant.orgId && grant.userId) {
    await writeGrantAudit(
      tx,
      grant.orgId,
      grant.userId,
      AuditEvent.CLI_DEVICE_LOGIN_REVOKED,
      grant.id,
      meta
    )
  }
}

async function issueFromGrant(
  tx: Tx,
  grant: GrantRow,
  meta: RequestMeta,
  now: Date
): Promise<IssuedUserSession> {
  if (!grant.userId) throw new Error('approved grant is missing its approver')
  if (grant.orgId) await setOrgContext(tx, grant.orgId, grant.userId)
  const session = await issueUserSessionInTx(tx, grant.userId, meta, now)
  await tx
    .update(cliDeviceGrants)
    .set({ status: 'consumed', consumedAt: now, sessionId: session.sessionId })
    .where(eq(cliDeviceGrants.id, grant.id))
  if (grant.orgId) {
    await writeGrantAudit(
      tx,
      grant.orgId,
      grant.userId,
      AuditEvent.CLI_DEVICE_LOGIN_CONSUMED,
      grant.id,
      meta
    )
  }
  return session
}

function terminalPoll(grant: GrantRow, now: Date): DevicePollResult | undefined {
  if (isExpired(grant, now) || grant.status === 'consumed') return { kind: 'expired' }
  if (grant.status === 'denied' || grant.status === 'revoked') return { kind: 'denied' }
  return undefined
}

async function pollLockedGrant(
  tx: Tx,
  grant: GrantRow | undefined,
  computed: string,
  meta: RequestMeta,
  now: Date
): Promise<DevicePollResult> {
  const matches = deviceCodeHashesEqual(grant?.deviceCodeHash, computed)
  if (!grant || !matches) return { kind: 'expired' }
  const terminal = terminalPoll(grant, now)
  if (terminal) return terminal
  if (polledTooSoon(grant, now)) {
    const intervalSeconds = Math.min(
      grant.intervalSeconds + CLI_DEVICE_SLOW_DOWN_STEP_SECONDS,
      CLI_DEVICE_MAX_INTERVAL_SECONDS
    )
    await tx
      .update(cliDeviceGrants)
      .set({ intervalSeconds, lastPolledAt: now })
      .where(eq(cliDeviceGrants.id, grant.id))
    return { kind: 'slow_down' }
  }
  await tx
    .update(cliDeviceGrants)
    .set({ lastPolledAt: now })
    .where(eq(cliDeviceGrants.id, grant.id))
  if (grant.status === 'pending') return { kind: 'pending' }
  if (!(await approverSessionLive(tx, grant))) {
    await markRevoked(tx, grant, meta, now)
    return { kind: 'denied' }
  }
  return { kind: 'session', session: await issueFromGrant(tx, grant, meta, now) }
}

export async function pollDeviceGrant(
  deviceCode: string,
  meta: RequestMeta,
  now = new Date()
): Promise<DevicePollResult> {
  const computed = hashDeviceCode(deviceCode)
  return getDb().transaction(async (dbTx) => {
    const tx = dbTx as Tx
    const rows = await tx
      .select()
      .from(cliDeviceGrants)
      .where(eq(cliDeviceGrants.deviceCodeHash, computed))
      .for('update')
      .limit(1)
    return pollLockedGrant(tx, rows[0], computed, meta, now)
  })
}

const NOT_A_MEMBER = 'You are not a member of that organization.'

export async function exchangeOrgCredential(
  user: { userId: string; sessionId: string },
  organizationId: string,
  meta: RequestMeta
): Promise<LoginResult & { orgRole: 'owner' | 'admin' | 'member' | 'viewer'; sessionId: string }> {
  const membership = await isOrgMember({ organizationId, userId: user.userId })
  if (membership.status === 'unavailable') {
    throw new AppError('service_unavailable', 'Membership could not be checked.', 503)
  }
  if (membership.status !== 'allowed') throw new AppError('not_org_member', NOT_A_MEMBER, 403)
  return withOrg(organizationId, async (tx) => {
    const role = await resolveActiveOrgRoleInTx(tx, user.userId, organizationId)
    if (!role) throw new AppError('not_org_member', NOT_A_MEMBER, 403)
    const login = await createLoginSessionInTx(
      tx,
      { id: user.userId, identityTokenId: await firstActorTokenIdForUser(tx, user.userId) },
      organizationId,
      meta,
      { accessTtlSeconds: CLI_ORG_CREDENTIAL_TTL_SECONDS, issueRefresh: false }
    )
    const created = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.jti, login.tokens.accessClaims.jti))
      .limit(1)
    const sessionId = created[0]?.id
    if (!sessionId) throw new Error('organization credential insert returned no row')
    await recordOrgCredential(tx, user.sessionId, organizationId, sessionId)
    return { ...login, orgRole: role, sessionId }
  })
}
