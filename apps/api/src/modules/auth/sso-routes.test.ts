import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  externalIdentities,
  organizations,
  orgMemberships,
  projectInvitations,
  projects,
  ssoLoginStates,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
  parseSetCookies,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerAuthStrategy, __resetAuthStrategiesForTests } from './strategies.js'
import { findLinkedIdentity } from './sso-routes.js'
import * as serviceModule from './service.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

let createApp: typeof import('../../app.js').createApp

const { initVault } = await bootstrapRouteIntegrationTest()

const PROVIDER = 'com.acme.test-idp'

async function createTestOrgWithUser(label: string) {
  const orgId = randomUUID()
  const suffix = orgId.slice(0, 8)
  await getDb()
    .insert(organizations)
    .values({ id: orgId, name: `sso-${label}-${suffix}`, slug: `sso-${label}-${suffix}` })
  const email = `sso-${label}-${randomUUID()}@example.com`
  const [user] = await getDb()
    .insert(users)
    .values({ email, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!user) throw new Error('expected user row')
  await getDb().insert(userIdentityTokens).values({ userId: user.id, displayName: email })
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId: user.id, role: 'member', status: 'active' })
  )
  return { orgId, userId: user.id, email }
}

async function linkExternalIdentity(orgId: string, userId: string, externalSubject: string) {
  await withOrg(orgId, (tx) =>
    tx.insert(externalIdentities).values({ orgId, userId, providerName: PROVIDER, externalSubject })
  )
}

describe('SSO routes (Story 14.3)', () => {
  beforeAll(async () => {
    const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
    await resetVaultForTest()
    await initVaultForTest(initVault, 'sso-routes-test-passphrase')
    createApp = (await import('../../app.js')).createApp
  })

  beforeEach(() => {
    __resetAuthStrategiesForTests()
  })

  describe('POST /start/:providerName (AC-3)', () => {
    it('mints state and sets a Lax/httpOnly/Secure cookie for a registered provider', async () => {
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: 'x', providerName: PROVIDER }),
      })
      const app = await createApp({ logger: false })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/start/${PROVIDER}`,
      })

      expect(res.statusCode).toBe(200)
      const setCookie = res.headers['set-cookie']
      const cookieHeaders: string[] = ([] as string[]).concat(setCookie as never)
      const stateCookieLine = cookieHeaders.find((c) => c.startsWith('sso-state='))
      expect(stateCookieLine).toBeDefined()
      expect(stateCookieLine?.toLowerCase()).toContain('httponly')
      expect(stateCookieLine?.toLowerCase()).toContain('samesite=lax')
      expect(res.json<{ data: { state: string } }>().data.state).toBeTruthy()

      await app.close()
    })

    it('returns generic 404 for an unregistered provider name', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sso/start/unknown-provider',
      })
      expect(res.statusCode).toBe(404)
      await app.close()
    })

    it("returns generic 404 for providerName 'local'", async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/sso/start/local' })
      expect(res.statusCode).toBe(404)
      await app.close()
    })
  })

  describe('POST /callback/:providerName (AC-4/AC-11)', () => {
    it('returns generic 404 for an unregistered provider name, never calling onAuthenticate', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sso/callback/unknown-provider',
        payload: {},
      })
      expect(res.statusCode).toBe(404)
      await app.close()
    })

    it('rejects with 401 invalid_state when the state cookie is missing, never invoking onAuthenticate', async () => {
      const onAuthenticate = vi.fn()
      registerAuthStrategy(PROVIDER, { onAuthenticate })
      const app = await createApp({ logger: false })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
      })

      expect(res.statusCode).toBe(401)
      expect(res.json<{ code: string }>().code).toBe('invalid_state')
      expect(onAuthenticate).not.toHaveBeenCalled()
      await app.close()
    })

    it('rejects with 401 invalid_state for an expired state, never invoking onAuthenticate', async () => {
      const onAuthenticate = vi.fn()
      registerAuthStrategy(PROVIDER, { onAuthenticate })
      const app = await createApp({ logger: false })

      const start = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/start/${PROVIDER}`,
      })
      const cookies = parseSetCookies(start.headers['set-cookie'])
      await getDb()
        .update(ssoLoginStates)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(ssoLoginStates.providerName, PROVIDER))

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })

      expect(res.statusCode).toBe(401)
      expect(onAuthenticate).not.toHaveBeenCalled()
      await app.close()
    })

    it('rejects a replayed (already-consumed) callback on the second attempt', async () => {
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: 'replay-test', providerName: PROVIDER }),
      })
      const app = await createApp({ logger: false })

      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])
      const cookieHeader = `sso-state=${cookies['sso-state']}`

      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: cookieHeader },
      })
      // No linked identity/invitation for this subject — expect account_link_required, not a crash.
      expect(first.statusCode).toBe(403)

      const second = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: cookieHeader },
      })
      expect(second.statusCode).toBe(401)
      expect(second.json<{ code: string }>().code).toBe('invalid_state')

      await app.close()
    })

    it('rejects with 401 invalid_state when the state was minted for a different provider', async () => {
      const otherProvider = 'com.acme.other-idp'
      registerAuthStrategy(PROVIDER, { onAuthenticate: vi.fn() })
      registerAuthStrategy(otherProvider, { onAuthenticate: vi.fn() })
      const app = await createApp({ logger: false })

      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${otherProvider}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })
  })

  describe('AC-5: successful onAuthenticate + matched external_identities issues a session', () => {
    it('issues the same session shape as local login for a linked user', async () => {
      const { orgId, userId } = await createTestOrgWithUser('linked')
      const subject = `sub-${randomUUID()}`
      await linkExternalIdentity(orgId, userId, subject)
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: subject, providerName: PROVIDER }),
      })
      const app = await createApp({ logger: false })

      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { userId: string; orgId: string } }>()
      expect(body.data.userId).toBe(userId)
      expect(body.data.orgId).toBe(orgId)
      const setCookie = ([] as string[]).concat(res.headers['set-cookie'] as never)
      expect(setCookie.some((c) => c.startsWith('access-token='))).toBe(true)

      await app.close()
    })

    it('Story 23.2 AC-4a: a successful SSO login writes the native-login-replacement proving latch', async () => {
      const { readReplacementLatch } = await import('./native-login-latch.js')
      const { systemSettings } = await import('@project-vault/db/schema')
      // The latch is a monotonic, no-reset-by-design instance-wide row (AC-4a) — this suite's
      // own prior successful-login tests may have already set it, so force it back to
      // unproven here rather than assuming a pristine table.
      await getDb()
        .update(systemSettings)
        .set({ nativeLoginReplacementProvenAt: null })
        .where(eq(systemSettings.id, 1))
      const before = await readReplacementLatch()
      expect(before?.replacementProvenAt ?? null).toBeNull()

      const { orgId, userId } = await createTestOrgWithUser('latch-linked')
      const subject = `sub-${randomUUID()}`
      await linkExternalIdentity(orgId, userId, subject)
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: subject, providerName: PROVIDER }),
      })
      const app = await createApp({ logger: false })

      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      expect(res.statusCode).toBe(200)

      const after = await readReplacementLatch()
      expect(after?.replacementProvenAt ?? null).not.toBeNull()

      await app.close()
    })

    it('Story 23.2 AC-5: a rejected callback (state consumed but invalid) never sets the latch', async () => {
      const { readReplacementLatch } = await import('./native-login-latch.js')
      const { systemSettings } = await import('@project-vault/db/schema')
      await getDb()
        .update(systemSettings)
        .set({ nativeLoginReplacementProvenAt: null })
        .where(eq(systemSettings.id, 1))

      const app = await createApp({ logger: false })
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: 'sso-state=not-a-real-state' },
      })
      expect(res.statusCode).not.toBe(200)

      const after = await readReplacementLatch()
      expect(after?.replacementProvenAt ?? null).toBeNull()

      await app.close()
    })

    it('returns an MfaChallengeResult (not a full session) for an MFA-enrolled linked user — no SSO-specific bypass', async () => {
      const { orgId, userId } = await createTestOrgWithUser('mfa-linked')
      await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId))
      const subject = `sub-${randomUUID()}`
      await linkExternalIdentity(orgId, userId, subject)
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: subject, providerName: PROVIDER }),
      })
      const app = await createApp({ logger: false })

      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { mfaRequired: boolean; mfaToken: string } }>()
      expect(body.data.mfaRequired).toBe(true)
      expect(body.data.mfaToken).toBeTruthy()
      const setCookie = res.headers['set-cookie']
        ? ([] as string[]).concat(res.headers['set-cookie'] as never)
        : []
      expect(setCookie.some((c) => c.startsWith('access-token='))).toBe(false)

      await app.close()
    })
  })

  describe('AC-6: issueSession failure after state consumed — user can retry immediately', () => {
    it('returns a retryable error and a fresh start call succeeds afterward', async () => {
      const { orgId, userId } = await createTestOrgWithUser('issue-fail')
      const subject = `sub-${randomUUID()}`
      await linkExternalIdentity(orgId, userId, subject)
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: subject, providerName: PROVIDER }),
      })
      const spy = vi
        .spyOn(serviceModule, 'createLoginSessionInTx')
        .mockRejectedValueOnce(new Error('simulated transient DB error'))
      const app = await createApp({ logger: false })

      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      expect(res.statusCode).toBe(503)

      const retryStart = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/start/${PROVIDER}`,
      })
      expect(retryStart.statusCode).toBe(200)

      spy.mockRestore()
      await app.close()
    })
  })

  describe('AC-7: no matching external_identities row — explicit rejection, never auto-link-by-email', () => {
    it('rejects a forged AuthResult asserting an existing user email with a novel externalSubject', async () => {
      const { orgId, userId, email } = await createTestOrgWithUser('victim')
      const forgedSubject = `forged-${randomUUID()}`
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({
          externalSubject: forgedSubject,
          providerName: PROVIDER,
          email,
        }),
      })
      const app = await createApp({ logger: false })

      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })

      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('account_link_required')

      // Never silently linked: no external_identities row was created binding the forged subject
      // to the victim's existing user, in this or any org.
      const linkedRows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(externalIdentities)
          .where(eq(externalIdentities.externalSubject, forgedSubject))
      )
      expect(linkedRows).toHaveLength(0)
      const [victimIdentities] = await withOrg(orgId, (tx) =>
        tx.select().from(externalIdentities).where(eq(externalIdentities.userId, userId))
      )
      expect(victimIdentities).toBeUndefined()

      await app.close()
    })
  })

  describe('AC-8: first-time SSO login via a pending project invitation, matched by email', () => {
    async function createOrgWithPendingInvitation(email: string) {
      const orgId = randomUUID()
      const suffix = orgId.slice(0, 8)
      await getDb()
        .insert(organizations)
        .values({ id: orgId, name: `sso-inv-${suffix}`, slug: `sso-inv-${suffix}` })
      const [project] = await withOrg(orgId, (tx) =>
        tx
          .insert(projects)
          .values({ orgId, name: `proj-${suffix}`, slug: `proj-${suffix}` })
          .returning({ id: projects.id })
      )
      if (!project) throw new Error('expected project row')
      const [invitedBy] = await getDb()
        .insert(users)
        .values({ email: `inviter-${randomUUID()}@example.com`, passwordHash: 'x' })
        .returning({ id: users.id })
      if (!invitedBy) throw new Error('expected inviter row')
      await withOrg(orgId, (tx) =>
        tx.insert(projectInvitations).values({
          orgId,
          projectId: project.id,
          email,
          roleToAssign: 'member',
          tokenHash: randomUUID(),
          invitedBy: invitedBy.id,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
      )
      return { orgId, projectId: project.id }
    }

    it('provisions a new user, links the identity, accepts the invitation, and issues a session', async () => {
      const email = `invited-${randomUUID()}@example.com`
      const { orgId } = await createOrgWithPendingInvitation(email)
      const subject = `sub-${randomUUID()}`
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: subject, providerName: PROVIDER, email }),
      })
      const app = await createApp({ logger: false })

      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { orgId: string } }>()
      expect(body.data.orgId).toBe(orgId)

      const [linked] = await withOrg(orgId, (tx) =>
        tx.select().from(externalIdentities).where(eq(externalIdentities.externalSubject, subject))
      )
      expect(linked).toBeDefined()

      await app.close()
    })

    it('AC-6e: provisions each invited user with a distinct, non-shared password hash — never env.AUTH_DUMMY_PASSWORD_HASH', async () => {
      const { env } = await import('../../config/env.js')

      const emailA = `invited-a-${randomUUID()}@example.com`
      const { orgId: orgIdA } = await createOrgWithPendingInvitation(emailA)
      const subjectA = `sub-a-${randomUUID()}`
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({
          externalSubject: subjectA,
          providerName: PROVIDER,
          email: emailA,
        }),
      })
      const appA = await createApp({ logger: false })
      const startA = await appA.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/start/${PROVIDER}`,
      })
      const cookiesA = parseSetCookies(startA.headers['set-cookie'])
      await appA.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookiesA['sso-state']}` },
      })
      await appA.close()

      const emailB = `invited-b-${randomUUID()}@example.com`
      const { orgId: orgIdB } = await createOrgWithPendingInvitation(emailB)
      const subjectB = `sub-b-${randomUUID()}`
      __resetAuthStrategiesForTests()
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({
          externalSubject: subjectB,
          providerName: PROVIDER,
          email: emailB,
        }),
      })
      const appB = await createApp({ logger: false })
      const startB = await appB.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/start/${PROVIDER}`,
      })
      const cookiesB = parseSetCookies(startB.headers['set-cookie'])
      await appB.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookiesB['sso-state']}` },
      })
      await appB.close()

      const [userA] = await withOrg(orgIdA, (tx) =>
        tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, emailA))
      )
      const [userB] = await withOrg(orgIdB, (tx) =>
        tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, emailB))
      )

      expect(userA?.passwordHash).toBeDefined()
      expect(userB?.passwordHash).toBeDefined()
      expect(userA?.passwordHash).not.toBe(userB?.passwordHash)
      expect(userA?.passwordHash).not.toBe(env.AUTH_DUMMY_PASSWORD_HASH)
      expect(userB?.passwordHash).not.toBe(env.AUTH_DUMMY_PASSWORD_HASH)
    })

    it('skips invitation-matching and falls through to account_link_required when AuthResult.email is absent', async () => {
      const subject = `sub-${randomUUID()}`
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: subject, providerName: PROVIDER }),
      })
      const app = await createApp({ logger: false })
      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('account_link_required')
      await app.close()
    })

    it('rejects rather than guessing when the same email has pending invitations in more than one org', async () => {
      const email = `multi-org-${randomUUID()}@example.com`
      await createOrgWithPendingInvitation(email)
      await createOrgWithPendingInvitation(email)
      const subject = `sub-${randomUUID()}`
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => ({ externalSubject: subject, providerName: PROVIDER, email }),
      })
      const app = await createApp({ logger: false })
      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      expect(res.statusCode).toBe(409)
      await app.close()
    })

    it('resolves a concurrent double-provisioning race with exactly one winner', async () => {
      const email = `race-${randomUUID()}@example.com`
      const { orgId } = await createOrgWithPendingInvitation(email)
      const subjectA = `sub-a-${randomUUID()}`
      const subjectB = `sub-b-${randomUUID()}`
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async (credential: string) => ({
          externalSubject: credential === 'a' ? subjectA : subjectB,
          providerName: PROVIDER,
          email,
        }),
      })
      const app = await createApp({ logger: false })

      const startA = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const startB = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookiesA = parseSetCookies(startA.headers['set-cookie'])
      const cookiesB = parseSetCookies(startB.headers['set-cookie'])

      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/v1/auth/sso/callback/${PROVIDER}`,
          payload: { credential: 'a' },
          headers: { cookie: `sso-state=${cookiesA['sso-state']}` },
        }),
        app.inject({
          method: 'POST',
          url: `/api/v1/auth/sso/callback/${PROVIDER}`,
          payload: { credential: 'b' },
          headers: { cookie: `sso-state=${cookiesB['sso-state']}` },
        }),
      ])

      // The loser's exact status is inherently timing-dependent: findCandidateInvitations (the
      // pre-transaction lookup) and claimInvitation (the atomic in-transaction guard) aren't the
      // same query, so if the winner's transaction commits before the loser's own pre-check runs,
      // the loser sees zero candidate invitations (403 account_link_required) instead of losing
      // the atomic claim (409 invitation_already_claimed). Both are safe, correct rejections of
      // the loser — asserting one specific code here just makes the test flaky under scheduling
      // pressure (e.g. CI) without catching any real bug. The invariant that actually matters is
      // exactly one winner and exactly one identity row, both asserted below.
      const statuses = [resA.statusCode, resB.statusCode].sort()
      const winners = statuses.filter((status) => status === 200)
      const losers = statuses.filter((status) => status !== 200)
      expect(winners).toEqual([200])
      expect(losers).toHaveLength(1)
      expect([403, 409]).toContain(losers[0])

      const linkedRows = await withOrg(orgId, (tx) =>
        tx.select().from(externalIdentities).where(eq(externalIdentities.providerName, PROVIDER))
      )
      const raceRows = linkedRows.filter((row) =>
        [subjectA, subjectB].includes(row.externalSubject)
      )
      expect(raceRows).toHaveLength(1)

      await app.close()
    })
  })

  describe('AC-9: onAuthenticate throws or times out — local login unaffected', () => {
    it('returns 502 sso_provider_error and leaves local login reachable', async () => {
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => {
          throw new Error('simulated IdP network failure')
        },
      })
      const app = await createApp({ logger: false })
      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      expect(res.statusCode).toBe(502)
      expect(res.json<{ code: string }>().code).toBe('sso_provider_error')

      const email = `local-still-works-${randomUUID()}@example.com`
      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email,
          password: 'correct-horse-battery-staple',
          orgName: `org-${randomUUID()}`,
        },
      })
      expect(register.statusCode).toBe(201)

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'correct-horse-battery-staple' },
      })
      expect(login.statusCode).toBe(200)

      await app.close()
    })

    it('treats a hung onAuthenticate() as a timeout and still responds', async () => {
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: () => new Promise(() => undefined),
      })
      const app = await createApp({ logger: false })
      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      expect(res.statusCode).toBe(502)

      await app.close()
    }, 15_000)

    it('Story 25.7 AC4/AC5: logs a structured extension.authenticate_failed event (subReason threw) via the migrated shared raceWithTimeout() primitive', async () => {
      const { createLoggerConfig } = await import('../../lib/logger.js')
      const { createLogCaptureStream, flushCapturedLogger, parseCapturedLogLines } =
        await import('../../__tests__/helpers/capture-logs.js')
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => {
          throw new Error('simulated IdP network failure — never-leak-detail check')
        },
      })
      const { stream, lines } = createLogCaptureStream()
      const app = await createApp({
        logger: {
          ...createLoggerConfig({
            NODE_ENV: 'development',
            LOG_LEVEL: 'info',
            SERVICE_NAME: 'api',
          }),
          stream,
        },
      })
      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      await flushCapturedLogger(app.log)
      expect(res.statusCode).toBe(502)

      const failureLogs = parseCapturedLogLines(lines).filter(
        (line) => line.eventType === 'extension.authenticate_failed'
      )
      expect(failureLogs).toHaveLength(1)
      expect(failureLogs[0]).toMatchObject({
        level: 'error',
        providerName: PROVIDER,
        subReason: 'threw',
      })
      // Never leaks the raw exception message/stack into the log payload.
      expect(JSON.stringify(failureLogs[0])).not.toContain(
        'simulated IdP network failure — never-leak-detail check'
      )

      await app.close()
    })

    it('Story 25.7 AC4/AC5: logs a structured extension.authenticate_failed event (subReason timed_out) via the migrated shared raceWithTimeout() primitive', async () => {
      const { createLoggerConfig } = await import('../../lib/logger.js')
      const { createLogCaptureStream, flushCapturedLogger, parseCapturedLogLines } =
        await import('../../__tests__/helpers/capture-logs.js')
      registerAuthStrategy(PROVIDER, {
        onAuthenticate: () => new Promise(() => undefined),
      })
      const { stream, lines } = createLogCaptureStream()
      const app = await createApp({
        logger: {
          ...createLoggerConfig({
            NODE_ENV: 'development',
            LOG_LEVEL: 'info',
            SERVICE_NAME: 'api',
          }),
          stream,
        },
      })
      const start = await app.inject({ method: 'POST', url: `/api/v1/auth/sso/start/${PROVIDER}` })
      const cookies = parseSetCookies(start.headers['set-cookie'])

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sso/callback/${PROVIDER}`,
        payload: {},
        headers: { cookie: `sso-state=${cookies['sso-state']}` },
      })
      await flushCapturedLogger(app.log)
      expect(res.statusCode).toBe(502)

      const failureLogs = parseCapturedLogLines(lines).filter(
        (line) => line.eventType === 'extension.authenticate_failed'
      )
      expect(failureLogs).toHaveLength(1)
      expect(failureLogs[0]).toMatchObject({
        level: 'error',
        providerName: PROVIDER,
        subReason: 'timed_out',
      })

      await app.close()
    }, 15_000)

    it('Story 23.2 AC-7: a declared extension whose strategy always throws never proves the latch — native login stays enabled (the single largest safety improvement over the original design)', async () => {
      const { readReplacementLatch } = await import('./native-login-latch.js')
      const { __resetNativeLoginPolicyForTests, resolveNativeLoginPolicy, isNativeLoginEnabled } =
        await import('./native-login-policy.js')
      const { systemSettings } = await import('@project-vault/db/schema')
      // The latch is a monotonic, no-reset-by-design instance-wide row (AC-4a) — this suite's
      // own prior successful-login tests may have already set it, so force it back to unproven
      // here rather than assuming a pristine table (same technique the AC-4a test above uses).
      await getDb()
        .update(systemSettings)
        .set({ nativeLoginReplacementProvenAt: null })
        .where(eq(systemSettings.id, 1))

      registerAuthStrategy(PROVIDER, {
        onAuthenticate: async () => {
          throw new Error('strategy is broken — never authenticates anyone')
        },
      })
      __resetNativeLoginPolicyForTests()
      await resolveNativeLoginPolicy({
        status: 'loaded',
        manifest: {
          name: PROVIDER,
          apiVersion: '1.2.0',
          capabilities: ['auth-provider'],
          replacesNativeLogin: true,
        },
        loadedAt: new Date().toISOString(),
        hooks: {
          authStrategy: {
            onAuthenticate: async () => ({ externalSubject: 'x', providerName: PROVIDER }),
          },
        },
      })

      const app = await createApp({ logger: false })
      try {
        // Several failed attempts — the latch is per-instance, not per-attempt, so this proves
        // "never" rather than merely "not yet" after one try.
        for (let i = 0; i < 3; i += 1) {
          const start = await app.inject({
            method: 'POST',
            url: `/api/v1/auth/sso/start/${PROVIDER}`,
          })
          const cookies = parseSetCookies(start.headers['set-cookie'])
          const res = await app.inject({
            method: 'POST',
            url: `/api/v1/auth/sso/callback/${PROVIDER}`,
            payload: {},
            headers: { cookie: `sso-state=${cookies['sso-state']}` },
          })
          expect(res.statusCode).toBe(502)
        }

        expect(isNativeLoginEnabled()).toBe(true)
        const latch = await readReplacementLatch()
        expect(latch?.replacementProvenAt ?? null).toBeNull()
      } finally {
        await app.close()
        __resetNativeLoginPolicyForTests()
        await resolveNativeLoginPolicy({ status: 'not_configured' })
      }
    })
  })

  describe('findLinkedIdentity (Story 30.2: ambiguous candidates field)', () => {
    it('an ambiguous match (same subject linked in 2+ orgs) includes the full candidate list', async () => {
      const subject = `ambiguous-subject-${randomUUID()}`
      const first = await createTestOrgWithUser('ambig-a')
      const second = await createTestOrgWithUser('ambig-b')
      await linkExternalIdentity(first.orgId, first.userId, subject)
      await linkExternalIdentity(second.orgId, second.userId, subject)

      const linked = await findLinkedIdentity(PROVIDER, subject)

      expect(linked.kind).toBe('ambiguous')
      if (linked.kind !== 'ambiguous') throw new Error('expected ambiguous')
      const candidateOrgIds = linked.candidates.map((c) => c.orgId).sort()
      expect(candidateOrgIds).toEqual([first.orgId, second.orgId].sort())
    })

    it('a single match still resolves to found, not ambiguous', async () => {
      const subject = `single-subject-${randomUUID()}`
      const { orgId, userId } = await createTestOrgWithUser('single')
      await linkExternalIdentity(orgId, userId, subject)

      const linked = await findLinkedIdentity(PROVIDER, subject)

      expect(linked).toEqual({ kind: 'found', orgId, userId })
    })
  })
})
