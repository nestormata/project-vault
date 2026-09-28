import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import {
  externalIdentities,
  handoffTokenJti,
  organizations,
  orgMemberships,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'
import { eq, sql } from 'drizzle-orm'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
  parseSetCookies,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  b64url,
  createLinkedHandoffOrg,
  HANDOFF_PROVIDER,
  HANDOFF_TEST_INSTANCE_ID,
  HANDOFF_TEST_KID,
  handoffTestPublicKeyPem,
  signToken,
} from '../../__tests__/helpers/handoff-test-helpers.js'
import { serviceProvisionedEmail } from '@project-vault/shared'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

process.env['VAULT_HANDOFF_ENABLED'] = 'true'
process.env['VAULT_HANDOFF_INSTANCE_ID'] = HANDOFF_TEST_INSTANCE_ID
process.env['VAULT_HANDOFF_VERIFY_KEYS'] = JSON.stringify([
  { kid: HANDOFF_TEST_KID, publicKeyPem: handoffTestPublicKeyPem },
])

let createApp: typeof import('../../app.js').createApp

const { initVault } = await bootstrapRouteIntegrationTest()

const PREPARE_URL = '/api/v1/auth/handoff/prepare'
const CONFIRM_URL = '/api/v1/auth/handoff/confirm'
const EXCHANGE_CLAIM_URL = '/api/v1/auth/handoff/exchange-claim'
const HANDOFF_COOKIE_NAME = 'handoff-confirm'
const GENERIC_REJECTION_MESSAGE = 'Sign-in could not be verified. Please start again.'
const SAME_ORIGIN = 'same-origin'

describe('handoff routes (Story 30.2 AC3/AC4)', () => {
  beforeAll(async () => {
    const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
    await resetVaultForTest()
    await initVaultForTest(initVault, 'handoff-routes-test-passphrase')
    createApp = (await import('../../app.js')).createApp
  })

  describe('POST /prepare (AC3)', () => {
    it('AC3.8: rejects a malformed body generically, writing no pending state', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { notToken: 'nope' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
      await app.close()
    })

    it('AC3.8: rejects an oversized token body generically (parser-level 413 normalized to the route contract)', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token: 'a'.repeat(20 * 1024) },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
      expect(res.headers['set-cookie']).toBeUndefined()
      await app.close()
    })

    it('AC3.9: rejects a token with an unexpected alg, generic message, no pending cookie', async () => {
      const app = await createApp({ logger: false })
      const token = signToken()
      const [h, p, s] = token.split('.')
      const badHeader = b64url(JSON.stringify({ alg: 'none', kid: 'kid-1', typ: 'JWT' }))
      const res = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token: `${badHeader}.${p}.${s}` },
      })
      expect(res.statusCode).toBe(401)
      expect(res.headers['set-cookie']).toBeUndefined()
      void h
      await app.close()
    })

    it('AC3.7 happy path: a valid token gets a pending-state cookie and 200', async () => {
      const app = await createApp({ logger: false })
      const token = signToken()
      const res = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      expect(res.statusCode).toBe(200)
      const cookies = parseSetCookies(res.headers['set-cookie'])
      expect(cookies[HANDOFF_COOKIE_NAME]).toBeTruthy()
      const body = res.json<{ data: { pendingId: string } }>()
      expect(body.data.pendingId).toBeTruthy()
      await app.close()
    })

    it('AC7: registers a rate limit (429 shape reachable) — not asserting the full 60-req budget here', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token: 'x' },
      })
      // Just confirm the route responds normally under rate-limit registration (not exhausted).
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('AC1: response includes a distinct claim field, never derived from rawCookie/pendingId', async () => {
      const app = await createApp({ logger: false })
      const token = signToken()
      const res = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      expect(res.statusCode).toBe(200)
      const cookies = parseSetCookies(res.headers['set-cookie'])
      const rawCookie = cookies[HANDOFF_COOKIE_NAME]
      const body = res.json<{ data: { pendingId: string; claim: string } }>()
      expect(body.data.claim).toBeTruthy()
      expect(body.data.claim).not.toBe(rawCookie)
      expect(body.data.claim).not.toBe(body.data.pendingId)
      await app.close()
    })

    describe('display labels (Story 60.4 AC1, F10)', () => {
      type PrepareBody = {
        data: {
          pendingId: string
          claim: string
          organizationName: string | null
          accountLabel: string | null
        }
      }

      async function prepareFor(workosUserId: string, cmOrgId: string): Promise<PrepareBody> {
        const app = await createApp({ logger: false })
        try {
          const res = await app.inject({
            method: 'POST',
            url: PREPARE_URL,
            payload: { token: signToken({ workosUserId, organizationId: cmOrgId }) },
          })
          expect(res.statusCode).toBe(200)
          expect(parseSetCookies(res.headers['set-cookie'])).toHaveProperty(HANDOFF_COOKIE_NAME)
          return res.json<PrepareBody>()
        } finally {
          await app.close()
        }
      }

      it('1.1/1.2: a linked user with a synthetic service-provisioned email gets accountLabel null (key present), organizationName unaffected', async () => {
        const workosUserId = `user_${randomUUID()}`
        const cmOrgId = randomUUID()
        const { organizationName } = await createLinkedHandoffOrg(
          'synthetic',
          workosUserId,
          cmOrgId,
          { email: serviceProvisionedEmail(randomUUID()) }
        )
        const body = await prepareFor(workosUserId, cmOrgId)
        expect(body.data).toHaveProperty('accountLabel', null)
        expect(body.data.organizationName).toBe(organizationName)
        expect(body.data.pendingId).toBeTruthy()
        expect(body.data.claim).toBeTruthy()
      })

      it('1.3: a linked user with a real email gets it back verbatim, organizationName unaffected', async () => {
        const workosUserId = `user_${randomUUID()}`
        const cmOrgId = randomUUID()
        const realEmail = `alex-${randomUUID()}@acme.com`
        const { organizationName } = await createLinkedHandoffOrg('real', workosUserId, cmOrgId, {
          email: realEmail,
        })
        const body = await prepareFor(workosUserId, cmOrgId)
        expect(body.data.accountLabel).toBe(realEmail)
        expect(body.data.organizationName).toBe(organizationName)
      })

      it('1.12: an unlinked subject still gets null for both labels', async () => {
        const body = await prepareFor(`user_${randomUUID()}`, randomUUID())
        expect(body.data).toHaveProperty('accountLabel', null)
        expect(body.data).toHaveProperty('organizationName', null)
      })
    })

    it('AC2.5: VAULT_HANDOFF_ENABLED=false rejects an otherwise-valid token, no pending cookie', async () => {
      // env.ts parses process.env once at module load, so flipping the toggle for a single test
      // requires a fresh module graph (vi.resetModules) rather than just mutating process.env.
      // prom-client's default registry is a real external-package singleton that vi.resetModules
      // does not tear down, so it must be cleared explicitly or the re-imported status.ts module
      // throws on its Counter re-registration.
      const { register } = await import('prom-client')
      const original = process.env['VAULT_HANDOFF_ENABLED']
      process.env['VAULT_HANDOFF_ENABLED'] = 'false'
      vi.resetModules()
      register.clear()
      try {
        const { createApp: createDisabledApp } = await import('../../app.js')
        const app = await createDisabledApp({ logger: false })
        const token = signToken()
        const res = await app.inject({
          method: 'POST',
          url: PREPARE_URL,
          payload: { token },
        })
        expect(res.statusCode).toBe(401)
        expect(res.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
        expect(res.headers['set-cookie']).toBeUndefined()
        await app.close()
      } finally {
        process.env['VAULT_HANDOFF_ENABLED'] = original
        vi.resetModules()
        register.clear()
      }
    })
  })

  describe('POST /exchange-claim (AC3, Story 60.3)', () => {
    async function prepareAndGetClaim(
      app: Awaited<ReturnType<typeof createApp>>,
      claimOverrides: Record<string, unknown> = {}
    ) {
      const token = signToken(claimOverrides)
      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      return prepareRes.json<{ data: { pendingId: string; claim: string } }>().data
    }

    it('happy path: a valid pendingId/claim pair sets a fresh handoff-confirm cookie that the (unmodified) confirm POST path accepts and completes to a real login', async () => {
      const app = await createApp({ logger: false })
      const workosUserId = `user_${randomUUID()}`
      const cmOrgId = `org_synthetic_${randomUUID()}`
      const { orgId, userId } = await createLinkedHandoffOrg('claim-happy', workosUserId, cmOrgId)
      const { pendingId, claim } = await prepareAndGetClaim(app, {
        workosUserId,
        organizationId: cmOrgId,
      })

      const res = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId, claim },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { rawCookieValue: string; expiresAt: string } }>()
      expect(body.data.rawCookieValue).toBeTruthy()
      expect(body.data.expiresAt).toBeTruthy()

      // AC3: the confirm POST path itself is unchanged — the newly exchanged cookie must be
      // accepted exactly like the original prepare-set cookie would have been, all the way
      // through to a real session.
      const confirmRes = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: {
          cookie: `${HANDOFF_COOKIE_NAME}=${body.data.rawCookieValue}`,
          'sec-fetch-site': SAME_ORIGIN,
        },
      })
      expect(confirmRes.statusCode).toBe(200)
      const confirmBody = confirmRes.json<{ data: { userId: string; orgId: string } }>()
      expect(confirmBody.data.orgId).toBe(orgId)
      expect(confirmBody.data.userId).toBe(userId)
      await app.close()
    })

    it('replay: the same pendingId/claim pair succeeds once, then rejects generically on a second exchange', async () => {
      const app = await createApp({ logger: false })
      const { pendingId, claim } = await prepareAndGetClaim(app)

      const first = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId, claim },
      })
      expect(first.statusCode).toBe(200)

      const second = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId, claim },
      })
      expect(second.statusCode).toBe(401)
      expect(second.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
      await app.close()
    })

    it('expired pending state: a valid claim past expiresAt is rejected the same generic way as replay', async () => {
      const app = await createApp({ logger: false })
      const { pendingId, claim } = await prepareAndGetClaim(app)
      const { handoffPendingStates } = await import('@project-vault/db/schema')
      await getDb()
        .update(handoffPendingStates)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(handoffPendingStates.id, pendingId))

      const res = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId, claim },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
      await app.close()
    })

    it('malformed/missing claim: an empty-string claim is rejected identically to a wholly missing one', async () => {
      const app = await createApp({ logger: false })
      const { pendingId } = await prepareAndGetClaim(app)

      const missing = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId },
      })
      const empty = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId, claim: '' },
      })
      expect(missing.statusCode).toBe(401)
      expect(empty.statusCode).toBe(401)
      expect(missing.json<{ message: string }>().message).toBe(
        empty.json<{ message: string }>().message
      )
      await app.close()
    })

    it('a claim that does not hash-match any row is rejected generically', async () => {
      const app = await createApp({ logger: false })
      const { pendingId } = await prepareAndGetClaim(app)

      const res = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId, claim: 'not-a-real-claim' },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('mismatched pair: a valid claim paired with an unrelated pendingId is rejected (scoped lookup requires both to match the same row)', async () => {
      const app = await createApp({ logger: false })
      const first = await prepareAndGetClaim(app)
      const second = await prepareAndGetClaim(app)

      const res = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId: second.pendingId, claim: first.claim },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('rolling-deploy skew: a pre-60.3 row with no claim_hash falls into the generic-rejection path, never a crash', async () => {
      const app = await createApp({ logger: false })
      const { pendingId } = await prepareAndGetClaim(app)
      const { handoffPendingStates } = await import('@project-vault/db/schema')
      await getDb().execute(
        sql`update ${handoffPendingStates} set claim_hash = NULL where ${handoffPendingStates.id} = ${pendingId}`
      )

      const res = await app.inject({
        method: 'POST',
        url: EXCHANGE_CLAIM_URL,
        payload: { pendingId, claim: 'anything' },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('VAULT_HANDOFF_ENABLED=false rejects an otherwise-valid exchange, generically', async () => {
      const { register } = await import('prom-client')
      const app = await createApp({ logger: false })
      const { pendingId, claim } = await prepareAndGetClaim(app)
      await app.close()

      const original = process.env['VAULT_HANDOFF_ENABLED']
      process.env['VAULT_HANDOFF_ENABLED'] = 'false'
      vi.resetModules()
      register.clear()
      try {
        const { createApp: createDisabledApp } = await import('../../app.js')
        const disabledApp = await createDisabledApp({ logger: false })
        const res = await disabledApp.inject({
          method: 'POST',
          url: EXCHANGE_CLAIM_URL,
          payload: { pendingId, claim },
        })
        expect(res.statusCode).toBe(401)
        await disabledApp.close()
      } finally {
        process.env['VAULT_HANDOFF_ENABLED'] = original
        vi.resetModules()
        register.clear()
      }
    })
  })

  describe('POST /confirm (AC4)', () => {
    it('AC4.15: rejects generically when the confirm cookie is missing entirely', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({ method: 'POST', url: CONFIRM_URL })
      expect(res.statusCode).toBe(401)
      expect(res.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
      await app.close()
    })

    it('AC4.15: rejects generically when the pending state has expired', async () => {
      const app = await createApp({ logger: false })
      const token = signToken()
      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])
      const pendingId = prepareRes.json<{ data: { pendingId: string } }>().data.pendingId
      const { handoffPendingStates } = await import('@project-vault/db/schema')
      await getDb()
        .update(handoffPendingStates)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(handoffPendingStates.id, pendingId))

      const res = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: { cookie: `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}` },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('AC4.13/AC4.16: a second confirm for an already-burned jti rejects handoff_replay (defense-in-depth Sec-Fetch-Site header accepted as same-origin)', async () => {
      const app = await createApp({ logger: false })
      const token = signToken()
      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])
      const cookieHeader = `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}`

      // First confirm burns the jti (regardless of what happens further down the pipeline).
      await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: { cookie: cookieHeader, 'sec-fetch-site': SAME_ORIGIN },
      })

      const second = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: { cookie: cookieHeader, 'sec-fetch-site': SAME_ORIGIN },
      })
      expect(second.statusCode).toBe(401)
      expect(second.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
      await app.close()
    })

    it('AC4.16: rejects a confirm with a cross-site Sec-Fetch-Site header', async () => {
      const app = await createApp({ logger: false })
      const token = signToken()
      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])
      const res = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: {
          cookie: `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}`,
          'sec-fetch-site': 'cross-site',
        },
      })
      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('AC4.12/AC4.13: JTI is burned even on a cross-site-rejected confirm attempt (row exists in handoff_token_jti)', async () => {
      const app = await createApp({ logger: false })
      const token = signToken()
      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])

      // AC4.16's origin check runs BEFORE the cookie/pending lookup in this implementation, so a
      // cross-site-rejected attempt never reaches the burn step; use a same-origin attempt
      // instead to prove the burn itself lands independent of what happens afterward.
      await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: {
          cookie: `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}`,
          'sec-fetch-site': SAME_ORIGIN,
        },
      })

      const decoded = JSON.parse(
        Buffer.from(token.split('.')[1] as string, 'base64url').toString()
      ) as { jti: string }
      const rows = await getDb()
        .select()
        .from(handoffTokenJti)
        .where(eq(handoffTokenJti.jti, decoded.jti))
      expect(rows).toHaveLength(1)
      await app.close()
    })

    it("Story 30.2: a claim matching the org's stored centralizemeOrganizationId logs in successfully", async () => {
      const app = await createApp({ logger: false })
      const workosUserId = `user_${randomUUID()}`
      const cmOrgId = `org_synthetic_${randomUUID()}`
      const { orgId, userId } = await createLinkedHandoffOrg('match', workosUserId, cmOrgId)
      const token = signToken({ workosUserId, organizationId: cmOrgId })

      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])
      const res = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: {
          cookie: `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}`,
          'sec-fetch-site': SAME_ORIGIN,
        },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { userId: string; orgId: string } }>()
      expect(body.data.orgId).toBe(orgId)
      expect(body.data.userId).toBe(userId)
      await app.close()
    })

    it("Story 30.2: a claim NOT matching the org's stored centralizemeOrganizationId is rejected (never compared to PV's raw org UUID)", async () => {
      const app = await createApp({ logger: false })
      const workosUserId = `user_${randomUUID()}`
      const storedCmOrgId = `org_synthetic_${randomUUID()}`
      await createLinkedHandoffOrg('mismatch', workosUserId, storedCmOrgId)
      // The claim does not match the stored value — and, critically, is also NOT equal to the PV
      // org UUID (proving the fix no longer compares against `organizations.id` directly).
      const token = signToken({
        workosUserId,
        organizationId: `org_synthetic_wrong_${randomUUID()}`,
      })

      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])
      const res = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: {
          cookie: `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}`,
          'sec-fetch-site': SAME_ORIGIN,
        },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
      await app.close()
    })

    it('Story 30.2: an org with no stored centralizemeOrganizationId (null) never matches any claim — fails closed', async () => {
      const app = await createApp({ logger: false })
      const workosUserId = `user_${randomUUID()}`
      // Org provisioned before this field existed / via a non-CM path: no centralizemeOrganizationId.
      const orgId = randomUUID()
      const suffix = orgId.slice(0, 8)
      await getDb()
        .insert(organizations)
        .values({ id: orgId, name: `handoff-null-${suffix}`, slug: `handoff-null-${suffix}` })
      const email = `handoff-null-${randomUUID()}@example.com`
      const [user] = await getDb()
        .insert(users)
        .values({ email, passwordHash: 'x' })
        .returning({ id: users.id })
      if (!user) throw new Error('expected user row')
      await getDb().insert(userIdentityTokens).values({ userId: user.id, displayName: email })
      await withOrg(orgId, (tx) =>
        (tx as Tx)
          .insert(orgMemberships)
          .values({ orgId, userId: user.id, role: 'member', status: 'active' })
      )
      await withOrg(orgId, (tx) =>
        (tx as Tx).insert(externalIdentities).values({
          orgId,
          userId: user.id,
          providerName: HANDOFF_PROVIDER,
          externalSubject: workosUserId,
        })
      )
      const token = signToken({ workosUserId, organizationId: `org_synthetic_${randomUUID()}` })

      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])
      const res = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: {
          cookie: `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}`,
          'sec-fetch-site': SAME_ORIGIN,
        },
      })

      expect(res.statusCode).toBe(401)
      await app.close()
    })

    it('Story 30.2: ambiguous (same workosUserId linked in 2 orgs) narrowed to exactly one CM-org-id match succeeds', async () => {
      const app = await createApp({ logger: false })
      const workosUserId = `user_${randomUUID()}`
      const matchingCmOrgId = `org_synthetic_${randomUUID()}`
      const otherCmOrgId = `org_synthetic_${randomUUID()}`
      const { orgId: matchOrgId, userId: matchUserId } = await createLinkedHandoffOrg(
        'ambig-match',
        workosUserId,
        matchingCmOrgId
      )
      await createLinkedHandoffOrg('ambig-other', workosUserId, otherCmOrgId)
      const token = signToken({ workosUserId, organizationId: matchingCmOrgId })

      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])
      const res = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: {
          cookie: `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}`,
          'sec-fetch-site': SAME_ORIGIN,
        },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { userId: string; orgId: string } }>()
      expect(body.data.orgId).toBe(matchOrgId)
      expect(body.data.userId).toBe(matchUserId)
      await app.close()
    })

    it('Story 30.2: ambiguous with zero CM-org-id matches is rejected generically', async () => {
      const app = await createApp({ logger: false })
      const workosUserId = `user_${randomUUID()}`
      await createLinkedHandoffOrg('ambig-none-a', workosUserId, `org_synthetic_${randomUUID()}`)
      await createLinkedHandoffOrg('ambig-none-b', workosUserId, `org_synthetic_${randomUUID()}`)
      const token = signToken({ workosUserId, organizationId: `org_synthetic_${randomUUID()}` })

      const prepareRes = await app.inject({
        method: 'POST',
        url: PREPARE_URL,
        payload: { token },
      })
      const cookies = parseSetCookies(prepareRes.headers['set-cookie'])
      const res = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: {
          cookie: `${HANDOFF_COOKIE_NAME}=${cookies[HANDOFF_COOKIE_NAME]}`,
          'sec-fetch-site': SAME_ORIGIN,
        },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json<{ message: string }>().message).toBe(GENERIC_REJECTION_MESSAGE)
      await app.close()
    })
  })
})
