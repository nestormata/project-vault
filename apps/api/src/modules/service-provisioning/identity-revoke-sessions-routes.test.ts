import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSigner } from 'fast-jwt'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  externalIdentities,
  identityRevocationJti,
  platformSecurityEvents,
  sessions,
} from '@project-vault/db/schema'
import { AuditEvent, IdentityRevocationEvent } from '@project-vault/shared'
import { createApp } from '../../app.js'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { initVaultForTest } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  IDENTITY_REVOCATION_ALGORITHM,
  expectedIdentityRevocationAudience,
} from '../auth/identity-revocation-jwt.js'

configureAuthIntegrationEnv()

const SECRET = 'identity-revoke-sessions-test-secret-32b'
const INSTANCE_ID = 'pv-test'
const URL = '/api/v1/service/identities/revoke-sessions'
const VAULT_SECRET = 'identity-revoke-sessions-vault-secret'
const AUD = expectedIdentityRevocationAudience(INSTANCE_ID)

type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>['inject']>>
type ErrorBody = { code: string; message: string }

function errorBody(res: InjectResponse): ErrorBody {
  return res.json() as ErrorBody
}

function signToken(claims: Record<string, unknown> = {}, expiresIn = 60_000): string {
  return createSigner({ key: SECRET, algorithm: IDENTITY_REVOCATION_ALGORITHM, expiresIn })({
    iss: 'workos',
    sub: 'user_abc',
    aud: AUD,
    jti: randomUUID(),
    ...claims,
  }) as string
}

describe('POST /api/v1/service/identities/revoke-sessions', () => {
  let originalSecret: string | undefined
  let originalInstanceId: string | undefined

  beforeEach(async () => {
    const { env } = await import('../../config/env.js')
    originalSecret = (env as unknown as Record<string, unknown>)[
      'IDENTITY_REVOCATION_JWT_SECRET'
    ] as string | undefined
    originalInstanceId = (env as unknown as Record<string, unknown>)[
      'VAULT_HANDOFF_INSTANCE_ID'
    ] as string | undefined
    ;(env as unknown as Record<string, unknown>)['IDENTITY_REVOCATION_JWT_SECRET'] = SECRET
    ;(env as unknown as Record<string, unknown>)['VAULT_HANDOFF_INSTANCE_ID'] = INSTANCE_ID
  })

  afterEach(async () => {
    const { env } = await import('../../config/env.js')
    ;(env as unknown as Record<string, unknown>)['IDENTITY_REVOCATION_JWT_SECRET'] = originalSecret
    ;(env as unknown as Record<string, unknown>)['VAULT_HANDOFF_INSTANCE_ID'] = originalInstanceId
  })

  async function freshApp() {
    await resetVaultForTest()
    const { initVault } = await import('../../modules/vault/key-service.js')
    await initVaultForTest(initVault, VAULT_SECRET)
    return createApp({ logger: false, vaultGuardEnabled: true })
  }

  async function registerLinkedUser(
    app: Awaited<ReturnType<typeof createApp>>,
    label: string,
    subject: string
  ) {
    const email = `id-revoke-${label}-${randomUUID()}@example.com`
    const user = await registerAndLoginViaApi(app, {
      email,
      password: 'correct-horse-battery-staple',
      orgName: `IdRevoke ${label} ${randomUUID()}`,
    })
    await withOrg(user.orgId, (tx) =>
      tx.insert(externalIdentities).values({
        orgId: user.orgId,
        userId: user.userId,
        providerName: 'workos',
        externalSubject: subject,
      })
    )
    return { ...user, email, subject }
  }

  it('revokes matching sessions across orgs and returns 204 with an empty body', async () => {
    const app = await freshApp()
    const subject = `user_${randomUUID()}`
    const a = await registerLinkedUser(app, 'a', subject)
    const b = await registerLinkedUser(app, 'b', subject)

    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${signToken({ sub: subject })}` },
    })

    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    const activeA = await withOrg(a.orgId, (tx) =>
      tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.orgId, a.orgId), isNull(sessions.revokedAt)))
    )
    const activeB = await withOrg(b.orgId, (tx) =>
      tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.orgId, b.orgId), isNull(sessions.revokedAt)))
    )
    expect(activeA).toHaveLength(0)
    expect(activeB).toHaveLength(0)

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader(a.cookies) },
    })
    expect(me.statusCode).not.toBe(200)

    const orgAudit = await withOrg(a.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(
          eq(auditLogEntries.eventType, AuditEvent.IDENTITY_SESSIONS_REVOKED_BY_TRUSTED_CALLER)
        )
    )
    expect(orgAudit.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(orgAudit[0]?.payload)).not.toContain(subject)
    await app.close()
  })

  it('looks up matching identities through the admin pool without a SQL function', async () => {
    const dbModule = await import('../../lib/db.js')
    const spy = vi.spyOn(dbModule, 'getAdminDb')
    const app = await freshApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: `Bearer ${signToken({ sub: `missing_${randomUUID()}` })}` },
      })
      expect(res.statusCode).toBe(204)
      expect(res.body).toBe('')
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      await app.close()
    }
  })

  it('returns the same 204 for an unknown identity and for zero remaining sessions', async () => {
    const app = await freshApp()
    const unknown = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${signToken({ sub: `missing_${randomUUID()}` })}` },
    })
    expect(unknown.statusCode).toBe(204)
    expect(unknown.body).toBe('')

    const linked = await registerLinkedUser(app, 'zero', `user_${randomUUID()}`)
    const first = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${signToken({ sub: linked.subject })}` },
    })
    expect(first.statusCode).toBe(204)
    const second = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${signToken({ sub: linked.subject })}` },
    })
    expect(second.statusCode).toBe(204)
    expect(second.body).toBe('')
    await app.close()
  })

  it('does not revoke a different issuer or subject', async () => {
    const app = await freshApp()
    const target = await registerLinkedUser(app, 'keep', `user_${randomUUID()}`)
    const other = await registerLinkedUser(app, 'other', `user_${randomUUID()}`)

    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: {
        authorization: `Bearer ${signToken({ iss: 'other-idp', sub: target.subject })}`,
      },
    })
    expect(res.statusCode).toBe(204)

    const activeTarget = await withOrg(target.orgId, (tx) =>
      tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.orgId, target.orgId), isNull(sessions.revokedAt)))
    )
    const activeOther = await withOrg(other.orgId, (tx) =>
      tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.orgId, other.orgId), isNull(sessions.revokedAt)))
    )
    expect(activeTarget.length).toBeGreaterThan(0)
    expect(activeOther.length).toBeGreaterThan(0)
    await app.close()
  })

  it('uses one uniform 401 body for missing bearer, bad signature, wrong aud, and replay', async () => {
    const app = await freshApp()
    const subject = `user_${randomUUID()}`
    await registerLinkedUser(app, 'auth', subject)
    const jti = randomUUID()
    const good = signToken({ sub: subject, jti })

    const missing = await app.inject({ method: 'POST', url: URL })
    const badSig = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer not-a.jwt.token' },
    })
    const wrongAud = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${signToken({ sub: subject, aud: 'node:other' })}` },
    })
    const first = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${good}` },
    })
    const replay = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${good}` },
    })

    expect(first.statusCode).toBe(204)
    for (const res of [missing, badSig, wrongAud, replay]) {
      expect(res.statusCode).toBe(401)
      expect(errorBody(res)).toEqual({
        code: 'trusted_caller_revocation_rejected',
        message: 'Trusted caller revocation was rejected',
      })
    }

    const burned = await getDb()
      .select({ jti: identityRevocationJti.jti })
      .from(identityRevocationJti)
      .where(eq(identityRevocationJti.jti, jti))
    expect(burned).toHaveLength(1)

    const rejected = await getDb()
      .select({ eventType: platformSecurityEvents.eventType })
      .from(platformSecurityEvents)
      .where(
        eq(platformSecurityEvents.eventType, IdentityRevocationEvent.IDENTITY_REVOCATION_REJECTED)
      )
    expect(rejected.length).toBeGreaterThanOrEqual(3)
    await app.close()
  })

  it('fails closed when the secret is unset', async () => {
    const app = await freshApp()
    const { env } = await import('../../config/env.js')
    ;(env as unknown as Record<string, unknown>)['IDENTITY_REVOCATION_JWT_SECRET'] = undefined
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${signToken()}` },
    })
    expect(res.statusCode).toBe(401)
    expect(errorBody(res).code).toBe('trusted_caller_revocation_rejected')
    await app.close()
  })

  it('leaves the 31.1 org-wide header route unchanged', async () => {
    const app = await freshApp()
    const { env } = await import('../../config/env.js')
    const previous = (env as unknown as Record<string, unknown>)['SERVICE_REVOCATION_TOKEN']
    const orgToken = 'test-only-service-revocation-token-32-bytes-min'
    ;(env as unknown as Record<string, unknown>)['SERVICE_REVOCATION_TOKEN'] = orgToken
    const owner = await registerAndLoginViaApi(app, {
      email: `id-revoke-31-1-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `IdRevoke 31.1 ${randomUUID()}`,
    })
    const { organizations } = await import('@project-vault/db/schema')
    const cmId = `org_synthetic_${randomUUID()}`
    await getDb()
      .update(organizations)
      .set({ centralizemeOrganizationId: cmId })
      .where(eq(organizations.id, owner.orgId))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/service/organizations/${encodeURIComponent(cmId)}/revoke-sessions`,
      headers: { 'x-service-revocation-token': orgToken },
      payload: { requestId: randomUUID() },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      data: { organizationId: owner.orgId, requestId: expect.any(String) },
    })
    ;(env as unknown as Record<string, unknown>)['SERVICE_REVOCATION_TOKEN'] = previous
    await app.close()
  })
})
