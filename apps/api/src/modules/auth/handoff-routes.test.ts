import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import {
  auditLogEntries,
  handoffNonces,
  handoffTokenJti,
  platformSecurityEvents,
  sessions,
} from '@project-vault/db/schema'
import { and, count, eq } from 'drizzle-orm'
import { HandoffEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
  parseSetCookies,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  b64url,
  createLinkedHandoffOrg,
  HANDOFF_TEST_INSTANCE_ID,
  HANDOFF_TEST_KID,
  HANDOFF_TEST_START_URL,
  handoffTestPublicKeyPem,
  signToken,
} from '../../__tests__/helpers/handoff-test-helpers.js'
import * as nonceDb from './handoff-nonce-db.js'

vi.mock('./handoff-nonce-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof nonceDb>()
  return {
    ...actual,
    consumeHandoffNonce: vi.fn(actual.consumeHandoffNonce),
    insertHandoffNonce: vi.fn(actual.insertHandoffNonce),
    burnHandoffJti: vi.fn(actual.burnHandoffJti),
  }
})

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

process.env['VAULT_HANDOFF_ENABLED'] = 'true'
process.env['VAULT_HANDOFF_INSTANCE_ID'] = HANDOFF_TEST_INSTANCE_ID
process.env['VAULT_HANDOFF_START_URL'] = HANDOFF_TEST_START_URL
process.env['VAULT_HANDOFF_VERIFY_KEYS'] = JSON.stringify([
  { kid: HANDOFF_TEST_KID, publicKeyPem: handoffTestPublicKeyPem },
])

let createApp: typeof import('../../app.js').createApp

const { initVault } = await bootstrapRouteIntegrationTest()
// Imported after the bootstrap: it reads env at module load.
const { hashCookieValue } = await import('../../lib/opaque-cookie-token.js')

const START_URL = '/api/v1/auth/handoff/start'
const CLAIM_URL = '/api/v1/auth/handoff/claim'
const GENERIC_REJECTION = {
  code: 'handoff_rejected',
  message: 'Sign-in could not be verified. Please start again.',
}
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/

type App = Awaited<ReturnType<typeof createApp>>
type StartBody = { data: { nonce: string; expiresAt: string; redirectUrl: string } }
type ClaimPayload = { token: unknown; nonce: unknown }

let openApp: App | null = null

async function newApp(): Promise<App> {
  // A fresh app per test: the rate-limit store is in-memory per app instance.
  openApp = await createApp({ logger: false })
  return openApp
}

async function withHandoffEnv<T>(
  overrides: Record<string, string | null>,
  fn: (app: App) => Promise<T>
): Promise<T> {
  // env.ts parses process.env once at module load, so a different handoff env needs a fresh
  // module graph. prom-client's default registry survives vi.resetModules and must be cleared.
  const { register } = await import('prom-client')
  const originals = Object.fromEntries(
    Object.keys(overrides).map((k) => [
      k,
      (Reflect.get(process.env, k) as string | undefined) ?? null,
    ])
  )
  const apply = (values: Record<string, string | null>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) Reflect.deleteProperty(process.env, key)
      else Reflect.set(process.env, key, value)
    }
  }
  apply(overrides)
  vi.resetModules()
  register.clear()
  try {
    const { createApp: createOtherApp } = await import('../../app.js')
    const app = await createOtherApp({ logger: false })
    try {
      return await fn(app)
    } finally {
      await app.close()
    }
  } finally {
    apply(originals)
    vi.resetModules()
    register.clear()
  }
}

function sortedEvents(eventTypes: readonly string[]): string[] {
  return [...eventTypes].sort((a, b) => a.localeCompare(b))
}

function uniqueAgent(): string {
  return `handoff-routes-test/${randomUUID()}`
}

async function start(app: App): Promise<string> {
  const res = await app.inject({ method: 'POST', url: START_URL })
  expect(res.statusCode).toBe(200)
  return res.json<StartBody>().data.nonce
}

async function claim(app: App, payload: ClaimPayload, userAgent = uniqueAgent()) {
  const res = await app.inject({
    method: 'POST',
    url: CLAIM_URL,
    headers: { 'user-agent': userAgent },
    payload,
  })
  return { res, userAgent }
}

async function eventsFor(userAgent: string): Promise<string[]> {
  const rows = await getDb()
    .select({ eventType: platformSecurityEvents.eventType })
    .from(platformSecurityEvents)
    .where(eq(platformSecurityEvents.userAgent, userAgent))
  return sortedEvents(rows.map((r) => r.eventType))
}

async function nonceRow(nonce: string) {
  const [row] = await getDb()
    .select()
    .from(handoffNonces)
    .where(eq(handoffNonces.nonceHash, hashCookieValue(nonce)))
  return row
}

async function nonceRowCount(): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(handoffNonces)
  return row?.n ?? 0
}

async function jtiBurned(jti: string): Promise<boolean> {
  const rows = await getDb().select().from(handoffTokenJti).where(eq(handoffTokenJti.jti, jti))
  return rows.length === 1
}

async function sessionCount(orgId: string, userId: string): Promise<number> {
  const [row] = await withOrg(orgId, (tx) =>
    (tx as Tx)
      .select({ n: count() })
      .from(sessions)
      .where(and(eq(sessions.orgId, orgId), eq(sessions.userId, userId)))
  )
  return row?.n ?? 0
}

async function linkedUser(label: string, options = {}) {
  const workosUserId = `user_${randomUUID()}`
  const cmOrgId = `org_synthetic_${randomUUID()}`
  const linked = await createLinkedHandoffOrg(label, workosUserId, cmOrgId, options)
  return { ...linked, workosUserId, cmOrgId }
}

describe('handoff routes (Story 73.1 nonce-bound handoff)', () => {
  beforeAll(async () => {
    const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
    await resetVaultForTest()
    await initVaultForTest(initVault, 'handoff-routes-test-passphrase')
    createApp = (await import('../../app.js')).createApp
  })

  afterEach(async () => {
    vi.mocked(nonceDb.consumeHandoffNonce).mockClear()
    await openApp?.close()
    openApp = null
  })

  describe('POST /start (AC1)', () => {
    it('mints a 32-byte base64url nonce, stores only its HMAC with a 120 s expiry, and appends it to the start URL', async () => {
      const app = await newApp()
      const before = Date.now()
      const res = await app.inject({ method: 'POST', url: START_URL })

      expect(res.statusCode).toBe(200)
      expect(res.headers['set-cookie']).toBeUndefined()
      const { nonce, expiresAt, redirectUrl } = res.json<StartBody>().data
      expect(nonce).toMatch(NONCE_PATTERN)
      const redirect = new URL(redirectUrl)
      expect(`${redirect.origin}${redirect.pathname}`).toBe('https://router.example/handoff/start')
      expect(redirect.searchParams.get('v')).toBe('1')
      expect(redirect.searchParams.getAll('nonce')).toEqual([nonce])

      const row = await nonceRow(nonce)
      expect(row?.consumedAt).toBeNull()
      const ttl = (row?.expiresAt.getTime() ?? 0) - before
      expect(ttl).toBeGreaterThan(115_000)
      expect(ttl).toBeLessThanOrEqual(121_000)
      expect(new Date(expiresAt).getTime()).toBe(row?.expiresAt.getTime())
      const raw = await getDb()
        .select()
        .from(handoffNonces)
        .where(eq(handoffNonces.nonceHash, nonce))
      expect(raw).toHaveLength(0)
    })

    it('mints a different nonce on every call', async () => {
      const app = await newApp()
      expect(await start(app)).not.toBe(await start(app))
    })

    it.each([
      ['handoff is disabled', { VAULT_HANDOFF_ENABLED: 'false' }],
      ['VAULT_HANDOFF_START_URL is unset', { VAULT_HANDOFF_START_URL: null }],
    ])('rejects generically and stores nothing when %s', async (_label, overrides) => {
      const before = await nonceRowCount()
      await withHandoffEnv(overrides, async (app) => {
        const res = await app.inject({ method: 'POST', url: START_URL })
        expect(res.statusCode).toBe(401)
        expect(res.json()).toEqual(GENERIC_REJECTION)
      })
      expect(await nonceRowCount()).toBe(before)
    })

    it('fails closed with the generic rejection when the nonce store is down', async () => {
      const app = await newApp()
      vi.mocked(nonceDb.insertHandoffNonce).mockRejectedValueOnce(new Error('db down'))
      const userAgent = uniqueAgent()
      const res = await app.inject({
        method: 'POST',
        url: START_URL,
        headers: { 'user-agent': userAgent },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual(GENERIC_REJECTION)
      expect(await eventsFor(userAgent)).toEqual([HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE])
    })
  })

  describe('POST /claim golden path (AC2)', () => {
    it('signs the linked user in with a new session, consumes the nonce, burns the jti and audits success', async () => {
      const app = await newApp()
      const { orgId, userId, workosUserId, cmOrgId } = await linkedUser('golden')
      const nonce = await start(app)
      const jti = `jti-${randomUUID()}`
      const token = signToken({ workosUserId, organizationId: cmOrgId, nonce, jti })

      const { res, userAgent } = await claim(app, { token, nonce })

      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { userId: string; orgId: string } }>().data).toMatchObject({
        userId,
        orgId,
      })
      expect(Object.keys(parseSetCookies(res.headers['set-cookie'])).length).toBeGreaterThan(0)
      expect((await nonceRow(nonce))?.consumedAt).toBeInstanceOf(Date)
      expect(await jtiBurned(jti)).toBe(true)
      expect(await sessionCount(orgId, userId)).toBe(1)
      expect(await eventsFor(userAgent)).toEqual([])
      const audited = await withOrg(orgId, (tx) =>
        (tx as Tx)
          .select({ eventType: auditLogEntries.eventType })
          .from(auditLogEntries)
          .where(
            and(
              eq(auditLogEntries.orgId, orgId),
              eq(auditLogEntries.eventType, HandoffEvent.HANDOFF_LOGIN_SUCCEEDED)
            )
          )
      )
      expect(audited).toHaveLength(1)
    })

    it('returns the MFA challenge instead of a session for an MFA-enrolled user, after the nonce check', async () => {
      const app = await newApp()
      const { orgId, userId, workosUserId, cmOrgId } = await linkedUser('mfa', {
        mfaEnrolled: true,
      })
      const nonce = await start(app)
      const token = signToken({ workosUserId, organizationId: cmOrgId, nonce })

      const { res } = await claim(app, { token, nonce })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { mfaRequired: boolean; mfaToken: string } }>()
      expect(body.data.mfaRequired).toBe(true)
      expect(body.data.mfaToken).toBeTruthy()
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(await sessionCount(orgId, userId)).toBe(0)
      expect((await nonceRow(nonce))?.consumedAt).toBeInstanceOf(Date)
    })
  })

  describe('POST /claim nonce failures (AC2 edge, AC3, AC4)', () => {
    async function expectRejected(
      result: Awaited<ReturnType<typeof claim>>,
      eventTypes: string[]
    ): Promise<void> {
      expect(result.res.statusCode).toBe(401)
      expect(result.res.json()).toEqual(GENERIC_REJECTION)
      expect(result.res.headers['set-cookie']).toBeUndefined()
      expect(await eventsFor(result.userAgent)).toEqual(sortedEvents(eventTypes))
    }

    it('a missing nonce (no cookie) is handoff_nonce_missing and the token is never verified or burned', async () => {
      const app = await newApp()
      const { workosUserId, cmOrgId } = await linkedUser('missing')
      const jti = `jti-${randomUUID()}`
      const token = signToken({ workosUserId, organizationId: cmOrgId, nonce: 'A'.repeat(43), jti })

      await expectRejected(await claim(app, { token, nonce: null }), [
        HandoffEvent.HANDOFF_NONCE_MISSING,
      ])
      await expectRejected(await claim(app, { token, nonce: '' }), [
        HandoffEvent.HANDOFF_NONCE_MISSING,
      ])
      expect(await jtiBurned(jti)).toBe(false)
      expect(nonceDb.consumeHandoffNonce).not.toHaveBeenCalled()
    })

    it('a nonce with no record is handoff_nonce_unknown', async () => {
      const app = await newApp()
      const nonce = 'B'.repeat(43)
      await expectRejected(await claim(app, { token: signToken({ nonce }), nonce }), [
        HandoffEvent.HANDOFF_NONCE_UNKNOWN,
      ])
    })

    it('the same nonce presented again, even with a valid fresh token, is handoff_nonce_reused and mints no session', async () => {
      const app = await newApp()
      const { orgId, userId, workosUserId, cmOrgId } = await linkedUser('reused')
      const nonce = await start(app)
      const first = await claim(app, {
        token: signToken({ workosUserId, organizationId: cmOrgId, nonce }),
        nonce,
      })
      expect(first.res.statusCode).toBe(200)

      await expectRejected(
        await claim(app, {
          token: signToken({ workosUserId, organizationId: cmOrgId, nonce }),
          nonce,
        }),
        [HandoffEvent.HANDOFF_NONCE_REUSED]
      )
      expect(await sessionCount(orgId, userId)).toBe(1)
    })

    it('a nonce past its expiry is handoff_nonce_expired', async () => {
      const app = await newApp()
      const nonce = await start(app)
      await getDb()
        .update(handoffNonces)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(handoffNonces.nonceHash, hashCookieValue(nonce)))

      await expectRejected(await claim(app, { token: signToken({ nonce }), nonce }), [
        HandoffEvent.HANDOFF_NONCE_EXPIRED,
      ])
    })

    it('a token signed for another nonce is handoff_nonce_mismatch, and the cookie nonce is spent anyway (D5)', async () => {
      const app = await newApp()
      const { orgId, userId, workosUserId, cmOrgId } = await linkedUser('mismatch')
      const victimNonce = await start(app)
      const attackerNonce = await start(app)
      const attackerToken = signToken({
        workosUserId,
        organizationId: cmOrgId,
        nonce: attackerNonce,
      })

      await expectRejected(await claim(app, { token: attackerToken, nonce: victimNonce }), [
        HandoffEvent.HANDOFF_NONCE_MISMATCH,
      ])
      expect((await nonceRow(victimNonce))?.consumedAt).toBeInstanceOf(Date)
      expect(await sessionCount(orgId, userId)).toBe(0)

      await expectRejected(
        await claim(app, {
          token: signToken({ workosUserId, organizationId: cmOrgId, nonce: victimNonce }),
          nonce: victimNonce,
        }),
        [HandoffEvent.HANDOFF_NONCE_REUSED]
      )
    })

    it('a token with no nonce claim is handoff_nonce_mismatch', async () => {
      const app = await newApp()
      const nonce = await start(app)
      await expectRejected(await claim(app, { token: signToken(), nonce }), [
        HandoffEvent.HANDOFF_NONCE_MISMATCH,
      ])
    })

    it('a consume-time store outage fails closed with handoff_replay_store_unavailable', async () => {
      const app = await newApp()
      const nonce = await start(app)
      vi.mocked(nonceDb.consumeHandoffNonce).mockRejectedValueOnce(new Error('db down'))

      await expectRejected(await claim(app, { token: signToken({ nonce }), nonce }), [
        HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE,
      ])
    })
  })

  describe('POST /claim token, jti and org failures (60-3/60-6 guarantees)', () => {
    async function expectRejectedWith(
      payload: ClaimPayload,
      app: App,
      eventTypes: string[]
    ): Promise<void> {
      const { res, userAgent } = await claim(app, payload)
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual(GENERIC_REJECTION)
      expect(await eventsFor(userAgent)).toEqual(sortedEvents(eventTypes))
    }

    it('a non-string token is handoff_malformed_claim, after the nonce is consumed', async () => {
      const app = await newApp()
      const nonce = await start(app)
      await expectRejectedWith({ token: 42, nonce }, app, [HandoffEvent.HANDOFF_MALFORMED_CLAIM])
      expect((await nonceRow(nonce))?.consumedAt).toBeInstanceOf(Date)
    })

    it('an oversized body is rejected generically (parser-level 413 normalized to the route contract)', async () => {
      const app = await newApp()
      const res = await app.inject({
        method: 'POST',
        url: CLAIM_URL,
        payload: { token: 'a'.repeat(20 * 1024), nonce: 'C'.repeat(43) },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json<{ message: string }>().message).toBe(GENERIC_REJECTION.message)
      expect(res.headers['set-cookie']).toBeUndefined()
    })

    it('a token with an unexpected alg is handoff_unexpected_alg', async () => {
      const app = await newApp()
      const nonce = await start(app)
      const [, p, s] = signToken({ nonce }).split('.')
      const badHeader = b64url(JSON.stringify({ alg: 'none', kid: HANDOFF_TEST_KID, typ: 'JWT' }))
      await expectRejectedWith({ token: `${badHeader}.${p}.${s}`, nonce }, app, [
        HandoffEvent.HANDOFF_UNEXPECTED_ALG,
      ])
    })

    it('a replayed jti is handoff_replay even with a fresh matching nonce', async () => {
      const app = await newApp()
      const { orgId, userId, workosUserId, cmOrgId } = await linkedUser('replay')
      const jti = `jti-${randomUUID()}`
      const firstNonce = await start(app)
      const first = await claim(app, {
        token: signToken({ workosUserId, organizationId: cmOrgId, nonce: firstNonce, jti }),
        nonce: firstNonce,
      })
      expect(first.res.statusCode).toBe(200)

      const secondNonce = await start(app)
      await expectRejectedWith(
        {
          token: signToken({ workosUserId, organizationId: cmOrgId, nonce: secondNonce, jti }),
          nonce: secondNonce,
        },
        app,
        [HandoffEvent.HANDOFF_REPLAY]
      )
      expect(await sessionCount(orgId, userId)).toBe(1)
    })

    it('a jti burn store outage fails closed with handoff_replay_store_unavailable', async () => {
      const app = await newApp()
      const { workosUserId, cmOrgId } = await linkedUser('burn-outage')
      const nonce = await start(app)
      vi.mocked(nonceDb.burnHandoffJti).mockRejectedValueOnce(new Error('db down'))
      await expectRejectedWith(
        { token: signToken({ workosUserId, organizationId: cmOrgId, nonce }), nonce },
        app,
        [HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE]
      )
    })

    it('an unlinked subject is handoff_org_mismatch and the jti is still burned', async () => {
      const app = await newApp()
      const nonce = await start(app)
      const jti = `jti-${randomUUID()}`
      await expectRejectedWith({ token: signToken({ nonce, jti }), nonce }, app, [
        HandoffEvent.HANDOFF_ORG_MISMATCH,
      ])
      expect(await jtiBurned(jti)).toBe(true)
    })

    it("a claim whose organizationId is not the org's stored centralizeme id is handoff_org_mismatch", async () => {
      const app = await newApp()
      const { workosUserId } = await linkedUser('org-mismatch')
      const nonce = await start(app)
      await expectRejectedWith(
        {
          token: signToken({ workosUserId, organizationId: `org_wrong_${randomUUID()}`, nonce }),
          nonce,
        },
        app,
        [HandoffEvent.HANDOFF_ORG_MISMATCH]
      )
    })

    it('a subject linked in two orgs narrows to the one whose centralizeme id matches', async () => {
      const app = await newApp()
      const workosUserId = `user_${randomUUID()}`
      const matchingCmOrgId = `org_synthetic_${randomUUID()}`
      const match = await createLinkedHandoffOrg('ambig-match', workosUserId, matchingCmOrgId)
      await createLinkedHandoffOrg('ambig-other', workosUserId, `org_synthetic_${randomUUID()}`)
      const nonce = await start(app)
      const { res } = await claim(app, {
        token: signToken({ workosUserId, organizationId: matchingCmOrgId, nonce }),
        nonce,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { orgId: string } }>().data.orgId).toBe(match.orgId)
    })

    it('an inactive membership is rejected generically with no session', async () => {
      const app = await newApp()
      const { orgId, userId, workosUserId, cmOrgId } = await linkedUser('inactive', {
        membershipStatus: 'deactivated',
      })
      const nonce = await start(app)
      const { res } = await claim(app, {
        token: signToken({ workosUserId, organizationId: cmOrgId, nonce }),
        nonce,
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual(GENERIC_REJECTION)
      expect(await sessionCount(orgId, userId)).toBe(0)
    })

    it('an unknown claimsVersion still signs in and records the unknown-version events', async () => {
      const app = await newApp()
      const { workosUserId, cmOrgId } = await linkedUser('claims-v2')
      const nonce = await start(app)
      const { res, userAgent } = await claim(app, {
        token: signToken({ workosUserId, organizationId: cmOrgId, nonce, claimsVersion: 2 }),
        nonce,
      })
      expect(res.statusCode).toBe(200)
      expect(await eventsFor(userAgent)).toEqual(
        sortedEvents([
          HandoffEvent.HANDOFF_UNKNOWN_CLAIMS_VERSION,
          HandoffEvent.HANDOFF_UNKNOWN_CAPABILITY,
        ])
      )
    })

    it('rejects generically and consumes nothing when handoff is disabled', async () => {
      const app = await newApp()
      const nonce = await start(app)
      await withHandoffEnv({ VAULT_HANDOFF_ENABLED: 'false' }, async (disabledApp) => {
        const res = await disabledApp.inject({
          method: 'POST',
          url: CLAIM_URL,
          payload: { token: signToken({ nonce }), nonce },
        })
        expect(res.statusCode).toBe(401)
        expect(res.json()).toEqual(GENERIC_REJECTION)
      })
      expect((await nonceRow(nonce))?.consumedAt).toBeNull()
    })
  })

  describe('retired routes (AC7)', () => {
    it.each(['/prepare', '/exchange-claim', '/confirm'])(
      'POST %s no longer exists',
      async (path) => {
        const app = await newApp()
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/auth/handoff${path}`,
          payload: {},
        })
        expect(res.statusCode).toBe(404)
      }
    )
  })
})
