import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { cliDeviceGrants, orgMemberships, sessions, users } from '@project-vault/db/schema'
import { env } from '../../config/env.js'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { totpForSecret } from '../../__tests__/helpers/totp.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  isOrgMember,
  isOrgMemberForScheduledTask,
  withScheduledTaskOrganization,
} from '../../lib/org-membership.js'

vi.setConfig({ testTimeout: 60_000 })

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
const TEST_CREDENTIAL = 'correct-horse-battery-staple'
const TOKEN_URL = '/api/v1/auth/cli/device/token'
const DEVICE_URL = '/api/v1/auth/cli/device'
const DECISION_URL = '/api/v1/auth/cli/device/decision'
const ORG_URL = '/api/v1/auth/cli/org'
const ME_URL = '/api/v1/auth/me'
const PASSPHRASE = 'cli-device-login-passphrase'
const FRONT_DOOR_HOST = 'front-door.example'

type TestApp = Awaited<ReturnType<typeof createApp>>

function freshTotp(secret: string, usedCode: string): string {
  const current = totpForSecret(secret)
  if (current !== usedCode) return current
  return totpForSecret(secret, Date.now() - 30_000)
}

describe('browser-approved CLI sign-in (Story 43.30)', () => {
  let app: TestApp
  let operator: Awaited<ReturnType<typeof enrollUserWithMfa>>

  beforeAll(async () => {
    await resetVaultForTest()
    app = await createApp()
    await initVaultForTest(initVault, PASSPHRASE)
    operator = await enrollUserWithMfa(app, {
      emailPrefix: 'device-operator',
      orgNamePrefix: 'Device Operator',
      password: TEST_CREDENTIAL,
    })
    await getDb()
      .update(users)
      .set({ isPlatformOperator: false })
      .where(eq(users.isPlatformOperator, true))
    await getDb()
      .update(users)
      .set({ isPlatformOperator: true })
      .where(eq(users.id, operator.userId))
  })

  afterAll(async () => {
    await app.close()
  })

  async function start() {
    const created = await app.inject({
      method: 'POST',
      url: DEVICE_URL,
      headers: { host: FRONT_DOOR_HOST },
      payload: { clientName: 'desk' },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json<{
      data: {
        deviceCode: string
        userCode: string
        verificationUri: string
        expiresIn: number
        interval: number
      }
    }>().data
    expect(body.verificationUri).not.toContain(FRONT_DOOR_HOST)
    return body
  }

  it('accepts a plain client name and rejects control characters', async () => {
    const accepted = await app.inject({
      method: 'POST',
      url: DEVICE_URL,
      payload: { clientName: 'invalid' },
    })
    expect(accepted.statusCode).toBe(201)
    const rejected = await app.inject({
      method: 'POST',
      url: DEVICE_URL,
      payload: { clientName: 'terminal\u0001' },
    })
    expect(rejected.statusCode).toBe(422)
  })

  it('slows down an immediate second poll and increases the server poll interval', async () => {
    const started = await start()
    const firstPoll = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: started.deviceCode },
    })
    expect(firstPoll.statusCode).toBe(400)
    expect(firstPoll.json()).toMatchObject({ code: 'authorization_pending' })

    const tooSoon = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: started.deviceCode },
    })
    expect(tooSoon.statusCode).toBe(400)
    expect(tooSoon.json()).toMatchObject({ code: 'slow_down' })
  })

  it('lets a non-operator approve and then call APIs with the bearer token', async () => {
    const member = await registerAndLoginViaApi(app, {
      email: `device-member-${randomUUID()}@example.com`,
      password: TEST_CREDENTIAL,
      orgName: `Device Member ${randomUUID()}`,
    })
    const started = await start()
    expect(started.verificationUri).toMatch(/\/cli\/device$/)
    expect(started.expiresIn).toBe(300)
    expect(started.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)

    const pendingStart = await start()
    const pending = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: pendingStart.deviceCode },
    })
    expect(pending.statusCode).toBe(400)
    expect(pending.json()).toMatchObject({ code: 'authorization_pending' })

    const approved = await app.inject({
      method: 'POST',
      url: DECISION_URL,
      headers: { cookie: cookieHeader(member.cookies) },
      payload: { userCode: started.userCode, decision: 'approve' },
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ data: { status: 'approved' } })

    const token = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: started.deviceCode },
    })
    expect(token.statusCode).toBe(200)
    const userSession = token.json<{
      data: {
        accessToken: string
        userId: string
        sessionId: string
        scope: string
        isPlatformOperator: boolean
      }
    }>().data
    expect(userSession.userId).toBe(member.userId)
    expect(userSession.scope).toBe('user')
    expect(userSession.isPlatformOperator).toBe(false)
    expect(userSession).not.toHaveProperty('orgId')

    const again = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: started.deviceCode },
    })
    expect(again.statusCode).toBe(400)
    expect(again.json()).toMatchObject({ code: 'expired_token' })

    const userMe = await app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { authorization: `Bearer ${userSession.accessToken}` },
    })
    expect(userMe.statusCode).toBe(401)
    expect(userMe.json()).toMatchObject({ code: 'org_scope_required' })

    const stranger = await app.inject({
      method: 'POST',
      url: ORG_URL,
      headers: { authorization: `Bearer ${userSession.accessToken}` },
      payload: { organizationId: operator.orgId },
    })
    expect(stranger.statusCode).toBe(403)
    expect(stranger.json()).toMatchObject({ code: 'not_org_member' })
    expect(await isOrgMember({ organizationId: member.orgId, userId: member.userId })).toEqual({
      status: 'allowed',
    })
    expect(await isOrgMember({ organizationId: operator.orgId, userId: member.userId })).toEqual({
      status: 'denied',
    })
    expect(await isOrgMember({ organizationId: 'not-a-uuid', userId: member.userId })).toEqual({
      status: 'unavailable',
      reason: 'membership_check_failed',
    })
    expect(
      await isOrgMemberForScheduledTask({ organizationId: member.orgId, userId: member.userId })
    ).toEqual({ status: 'unavailable', reason: 'membership_scope_unavailable' })
    await withScheduledTaskOrganization(member.orgId, async () => {
      await expect(
        isOrgMemberForScheduledTask({ organizationId: member.orgId, userId: member.userId })
      ).resolves.toEqual({ status: 'allowed' })
      await expect(
        isOrgMemberForScheduledTask({ organizationId: operator.orgId, userId: member.userId })
      ).resolves.toEqual({ status: 'unavailable', reason: 'membership_scope_mismatch' })
      await withOrg(member.orgId, async (tx) => {
        await tx
          .update(orgMemberships)
          .set({ status: 'deactivated' })
          .where(eq(orgMemberships.userId, member.userId))
      })
      await expect(
        isOrgMemberForScheduledTask({ organizationId: member.orgId, userId: member.userId })
      ).resolves.toEqual({ status: 'denied' })
      await withOrg(member.orgId, async (tx) => {
        await tx
          .update(orgMemberships)
          .set({ status: 'active' })
          .where(eq(orgMemberships.userId, member.userId))
      })
    })

    const exchanged = await app.inject({
      method: 'POST',
      url: ORG_URL,
      headers: {
        authorization: `Bearer ${userSession.accessToken}`,
        host: FRONT_DOOR_HOST,
      },
      payload: { organizationId: member.orgId },
    })
    expect(exchanged.statusCode).toBe(200)
    const orgCredential = exchanged.json<{
      data: {
        accessToken: string
        orgId: string
        sessionId: string
        scope: string
        expiresIn: number
      }
    }>().data
    expect(orgCredential.orgId).toBe(member.orgId)
    expect(orgCredential.scope).toBe('org')
    expect(orgCredential.expiresIn).toBe(900)

    const againOrg = await app.inject({
      method: 'POST',
      url: ORG_URL,
      headers: { authorization: `Bearer ${userSession.accessToken}` },
      payload: { organizationId: member.orgId },
    })
    expect(againOrg.statusCode).toBe(200)
    expect(againOrg.json<{ data: { sessionId: string } }>().data.sessionId).not.toBe(
      orgCredential.sessionId
    )

    const cookieWins = await app.inject({
      method: 'GET',
      url: ME_URL,
      headers: {
        authorization: `Bearer ${orgCredential.accessToken}`,
        cookie: cookieHeader(operator.cookies),
      },
    })
    expect(cookieWins.statusCode).toBe(200)
    expect(cookieWins.json<{ data: { userId: string } }>().data.userId).toBe(operator.userId)

    const me = await app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { authorization: `Bearer ${orgCredential.accessToken}` },
    })
    expect(me.statusCode).toBe(200)
    const meBody = me.json<{
      data: {
        isPlatformOperator: boolean
        orgRole: string
        sessionId: string
        userId: string
        orgId: string
      }
    }>().data
    expect(meBody).toMatchObject({
      isPlatformOperator: false,
      userId: member.userId,
      orgId: member.orgId,
    })
    expect(meBody.sessionId).toBe(orgCredential.sessionId)

    const orgs = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orgs',
      headers: { authorization: `Bearer ${orgCredential.accessToken}` },
    })
    expect(orgs.statusCode).toBe(403)
    expect(orgs.json()).toMatchObject({ code: 'platform_operator_required' })

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${orgCredential.sessionId}`,
      headers: { authorization: `Bearer ${orgCredential.accessToken}` },
    })
    expect(revoked.statusCode).toBe(204)
    const after = await app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { authorization: `Bearer ${orgCredential.accessToken}` },
    })
    expect(after.statusCode).toBe(401)
    expect(after.json()).toMatchObject({ code: 'session_revoked' })
  })

  it('requires a fresh authenticator code before a platform operator can approve', async () => {
    const started = await start()
    const missing = await app.inject({
      method: 'POST',
      url: DECISION_URL,
      headers: { cookie: cookieHeader(operator.cookies) },
      payload: { userCode: started.userCode, decision: 'approve' },
    })
    expect(missing.statusCode).toBe(401)
    expect(missing.json()).toMatchObject({ code: 'step_up_required' })

    const approved = await app.inject({
      method: 'POST',
      url: DECISION_URL,
      headers: { cookie: cookieHeader(operator.cookies) },
      payload: {
        userCode: started.userCode,
        decision: 'approve',
        totpCode: freshTotp(operator.secret, operator.enrollmentTotp),
      },
    })
    expect(approved.statusCode).toBe(200)
    const token = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: started.deviceCode },
    })
    expect(token.statusCode).toBe(200)
    const accessToken = token.json<{ data: { accessToken: string } }>().data.accessToken
    const exchanged = await app.inject({
      method: 'POST',
      url: ORG_URL,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { organizationId: operator.orgId },
    })
    expect(exchanged.statusCode).toBe(200)
    const orgToken = exchanged.json<{ data: { accessToken: string } }>().data.accessToken
    const me = await app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { authorization: `Bearer ${orgToken}` },
    })
    expect(me.json<{ data: { isPlatformOperator: boolean } }>().data.isPlatformOperator).toBe(true)
    const orgs = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orgs',
      headers: { authorization: `Bearer ${orgToken}` },
    })
    expect(orgs.json()).not.toMatchObject({ code: 'platform_operator_required' })
  })

  it('denies a grant and refuses a second decision', async () => {
    const member = await registerAndLoginViaApi(app, {
      email: `device-deny-${randomUUID()}@example.com`,
      password: TEST_CREDENTIAL,
      orgName: `Device Deny ${randomUUID()}`,
    })
    const started = await start()
    const denied = await app.inject({
      method: 'POST',
      url: DECISION_URL,
      headers: { cookie: cookieHeader(member.cookies) },
      payload: { userCode: started.userCode, decision: 'deny' },
    })
    expect(denied.statusCode).toBe(200)
    expect(denied.json()).toMatchObject({ data: { status: 'denied' } })
    const again = await app.inject({
      method: 'POST',
      url: DECISION_URL,
      headers: { cookie: cookieHeader(member.cookies) },
      payload: { userCode: started.userCode, decision: 'approve' },
    })
    expect(again.statusCode).toBe(400)
    expect(again.json()).toMatchObject({ code: 'invalid_user_code' })
    const token = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: started.deviceCode },
    })
    expect(token.statusCode).toBe(400)
    expect(token.json()).toMatchObject({ code: 'access_denied' })
  })

  it('refuses a platform operator who has no authenticator enrolled', async () => {
    const member = await registerAndLoginViaApi(app, {
      email: `device-no-totp-${randomUUID()}@example.com`,
      password: TEST_CREDENTIAL,
      orgName: `Device No Totp ${randomUUID()}`,
    })
    await getDb()
      .update(users)
      .set({ isPlatformOperator: false })
      .where(eq(users.id, operator.userId))
    await getDb().update(users).set({ isPlatformOperator: true }).where(eq(users.id, member.userId))
    try {
      const started = await start()
      const refused = await app.inject({
        method: 'POST',
        url: DECISION_URL,
        headers: { cookie: cookieHeader(member.cookies) },
        payload: { userCode: started.userCode, decision: 'approve' },
      })
      expect(refused.statusCode).toBe(403)
      expect(refused.json()).toMatchObject({ code: 'totp_enrollment_required' })
      const pending = await app.inject({
        method: 'POST',
        url: TOKEN_URL,
        payload: { deviceCode: started.deviceCode },
      })
      expect(pending.json()).toMatchObject({ code: 'authorization_pending' })
    } finally {
      await getDb()
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.id, member.userId))
      await getDb()
        .update(users)
        .set({ isPlatformOperator: true })
        .where(eq(users.id, operator.userId))
    }
  })

  it('does not issue a session after the approving session is revoked', async () => {
    const member = await registerAndLoginViaApi(app, {
      email: `device-revoke-${randomUUID()}@example.com`,
      password: TEST_CREDENTIAL,
      orgName: `Device Revoke ${randomUUID()}`,
    })
    const started = await start()
    const approved = await app.inject({
      method: 'POST',
      url: DECISION_URL,
      headers: { cookie: cookieHeader(member.cookies) },
      payload: { userCode: started.userCode, decision: 'approve' },
    })
    expect(approved.statusCode).toBe(200)
    const sessionId = (
      await app.inject({
        method: 'GET',
        url: ME_URL,
        headers: { cookie: cookieHeader(member.cookies) },
      })
    ).json<{ data: { sessionId: string } }>().data.sessionId
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${sessionId}`,
      headers: { cookie: cookieHeader(member.cookies) },
    })
    expect(revoked.statusCode).toBe(204)
    const token = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: started.deviceCode },
    })
    expect(token.statusCode).toBe(400)
    expect(token.json()).toMatchObject({ code: 'access_denied' })
    const grants = await getDb()
      .select({ status: cliDeviceGrants.status })
      .from(cliDeviceGrants)
      .where(eq(cliDeviceGrants.userId, member.userId))
    expect(grants.some((row) => row.status === 'consumed')).toBe(false)
    expect(grants.some((row) => row.status === 'revoked')).toBe(true)
  })

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    [
      'idle',
      { lastActiveAt: new Date(Date.now() - (env.SESSION_IDLE_TIMEOUT_MINUTES + 1) * 60_000) },
    ],
  ])('does not issue a session after the approving session is %s', async (_state, stale) => {
    const member = await registerAndLoginViaApi(app, {
      email: `device-stale-${randomUUID()}@example.com`,
      password: TEST_CREDENTIAL,
      orgName: `Device Stale ${randomUUID()}`,
    })
    const started = await start()
    const approved = await app.inject({
      method: 'POST',
      url: DECISION_URL,
      headers: { cookie: cookieHeader(member.cookies) },
      payload: { userCode: started.userCode, decision: 'approve' },
    })
    expect(approved.statusCode).toBe(200)
    const sessionId = (
      await app.inject({
        method: 'GET',
        url: ME_URL,
        headers: { cookie: cookieHeader(member.cookies) },
      })
    ).json<{ data: { sessionId: string } }>().data.sessionId
    await withOrg(member.orgId, (tx) =>
      tx.update(sessions).set(stale).where(eq(sessions.id, sessionId))
    )
    const token = await app.inject({
      method: 'POST',
      url: TOKEN_URL,
      payload: { deviceCode: started.deviceCode },
    })
    expect(token.statusCode).toBe(400)
    expect(token.json()).toMatchObject({ code: 'access_denied' })
  })
})
