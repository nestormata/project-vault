import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares, notificationQueue } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { bootstrapRouteIntegrationTest } from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { forEachSequential } from '../../lib/for-each-sequential.js'
import { bootCredentialRouteApp } from '../credentials/credential-route-test-helpers.js'
import { flushPendingLosingAttempts } from './external-service.js'
import {
  createExternalShareSeeder,
  nextVerificationTestAddress,
  readQueuedVerificationCode,
  verifyExternalShareForTest,
  type ExternalShareSeeder,
  type ShareOverrides,
} from './external-share-test-helpers.js'
import { VERIFICATION_CODE_TEMPLATE_ID } from './external-verification-service.js'
import {
  EXTERNAL_SHARE_MISS_FLOOR_MS,
  EXTERNAL_SHARE_VERIFICATION_MAX_ATTEMPTS,
  EXTERNAL_SHARE_VERIFICATION_MAX_SENDS,
} from './schema.js'
import { generateAndHashShareToken } from './service.js'

/**
 * Story 72-11 AC5-AC7 — guest recipient verification over a real DB and the real routes:
 * enumeration (identical answers across classes), the atomic attempt budget under a parallel
 * burst, resend throttle and cap, code expiry, single use, lock, the proof gate on the reveal and
 * the floor on every outcome. Deterministic; the statistical evidence is the 72-11 leg of
 * `external-timing.integration.test.ts`.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'external-verify',
  orgNamePrefix: 'External Verify Org',
})

const PAST = () => new Date(Date.now() - 60_000)
const GATED: ShareOverrides = { verificationRequired: true }
const MASK_SHAPE = /^[a-z0-9]\*\*\*@[a-z0-9]\*\*\*$/
const FAILED_BODY = {
  code: 'verification_failed',
  message: 'The code could not be verified. Request a new code and try again.',
}

const SEND = '/verification'
const CONFIRM = '/verification/confirm'
// A timer can fire a hair early relative to `performance.now()` (same margin as 65-4's tests).
const MIN_ELAPSED = EXTERNAL_SHARE_MISS_FLOOR_MS - 15

function accessUrl(token: string, suffix = '') {
  return `/api/v1/external-shares/access/${token}${suffix}`
}

describe('external share guest verification (Story 72-11)', () => {
  let app: TestApp
  let seeder: ExternalShareSeeder

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'external-verify-passphrase')
    seeder = await createExternalShareSeeder(app, registerOwner, 'verify')
  }, 120_000)

  afterAll(async () => {
    await flushPendingLosingAttempts()
    await app.close()
    await resetVaultForTest()
  })

  function post(url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url,
      remoteAddress: nextVerificationTestAddress(),
      ...(payload ? { payload } : {}),
    })
  }

  async function requestCode(token: string) {
    const response = await post(accessUrl(token, SEND))
    await flushPendingLosingAttempts()
    return response
  }

  /** Requests a code for `token` and reads it from the queued email (the test is the mailbox). */
  async function requestAndReadCode(token: string): Promise<string> {
    await requestCode(token)
    const code = await readQueuedVerificationCode(seeder.orgId, seeder.recipientEmail)
    if (!code) throw new Error('expected a queued verification code')
    return code
  }

  function confirm(token: string, code: string) {
    return post(accessUrl(token, CONFIRM), { code })
  }

  async function queuedCodeRows(): Promise<number> {
    const rows = await withOrg(seeder.orgId, (tx) =>
      tx
        .select({ id: notificationQueue.id })
        .from(notificationQueue)
        .where(eq(notificationQueue.templateId, VERIFICATION_CODE_TEMPLATE_ID))
    )
    return rows.length
  }

  async function seedVerified(overrides: ShareOverrides = {}) {
    const share = await seeder.seedShare({ ...GATED, ...overrides })
    const proof = await verifyExternalShareForTest(app, {
      orgId: seeder.orgId,
      token: share.token,
      recipientEmail: seeder.recipientEmail,
    })
    return { ...share, proof }
  }

  it('AC7: the metadata of a gated share is trimmed to name, sharer, expiry, status and the mask', async () => {
    const { token } = await seeder.seedShare(GATED)
    const response = await app.inject({ method: 'GET', url: accessUrl(token) })
    expect(response.statusCode).toBe(200)
    const data = response.json<{ data: Record<string, unknown> }>().data
    expect(Object.keys(data).sort()).toEqual(
      [
        'credentialName',
        'expiresAt',
        'maskedRecipient',
        'sharedByDisplayName',
        'status',
        'verificationRequired',
      ].sort()
    )
    expect(data['verificationRequired']).toBe(true)
    expect(data['maskedRecipient']).toBe('v***@v***')
  })

  it('a link-only share keeps its metadata shape plus verificationRequired: false', async () => {
    const { token } = await seeder.seedShare()
    const data = (await app.inject({ method: 'GET', url: accessUrl(token) })).json<{
      data: Record<string, unknown>
    }>().data
    expect(data['verificationRequired']).toBe(false)
    expect(data['maskedRecipient']).toBeUndefined()
    expect(data).toHaveProperty('credentialId')
    expect(data).toHaveProperty('fieldKey')
    expect(data).toHaveProperty('attributeKeys')
    expect(data).toHaveProperty('action')
  })

  describe('send route (V5)', () => {
    it('answers the same status, headers and body shape for every class, and only a live gated share queues a code', async () => {
      const before = await queuedCodeRows()
      const classes: Record<string, string> = {
        unknown: generateAndHashShareToken().rawToken,
        malformed: 'x',
        expired: (await seeder.seedShare({ ...GATED, status: 'expired', expiresAt: PAST() })).token,
        lazy: (await seeder.seedShare({ ...GATED, expiresAt: PAST() })).token,
        revoked: (await seeder.seedShare({ ...GATED, status: 'revoked' })).token,
        viewed: (await seeder.seedShare({ ...GATED, status: 'viewed', viewCount: 1 })).token,
        locked: (await seeder.seedShare({ ...GATED, status: 'revoked', lockedAt: new Date() }))
          .token,
        overCap: (
          await seeder.seedShare({
            ...GATED,
            verificationSendCount: EXTERNAL_SHARE_VERIFICATION_MAX_SENDS,
          })
        ).token,
        throttled: (await seeder.seedShare({ ...GATED, verificationSentAt: new Date() })).token,
        linkOnly: (await seeder.seedShare()).token,
        live: (await seeder.seedShare(GATED)).token,
      }

      const responses = await Promise.all(
        Object.entries(classes).map(async ([name, token]) => ({
          name,
          response: await post(accessUrl(token, SEND)),
        }))
      )
      await flushPendingLosingAttempts()

      for (const { response } of responses) {
        expect(response.statusCode).toBe(200)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.headers['referrer-policy']).toBe('no-referrer')
        const data = response.json<{ data: { maskedRecipient: string; cooldownSeconds: number } }>()
          .data
        expect(Object.keys(data).sort()).toEqual(['cooldownSeconds', 'maskedRecipient'])
        expect(data.cooldownSeconds).toBe(60)
        expect(data.maskedRecipient).toMatch(MASK_SHAPE)
      }
      expect(await queuedCodeRows()).toBe(before + 1)
    })

    it('V6: the mask of an unknown token is deterministic per token', async () => {
      const token = generateAndHashShareToken().rawToken
      const first = (await requestCode(token)).json<{ data: { maskedRecipient: string } }>()
      const second = (await requestCode(token)).json<{ data: { maskedRecipient: string } }>()
      expect(second.data.maskedRecipient).toBe(first.data.maskedRecipient)
    })

    it('queues a plain six-digit code with no link, token or credential name', async () => {
      const { token } = await seeder.seedShare(GATED)
      await requestCode(token)
      const [row] = await withOrg(seeder.orgId, (tx) =>
        tx
          .select()
          .from(notificationQueue)
          .where(eq(notificationQueue.templateId, VERIFICATION_CODE_TEMPLATE_ID))
          .orderBy(notificationQueue.createdAt)
      ).then((rows) => rows.slice(-1))
      expect(row?.recipientEmail).toBe(seeder.recipientEmail)
      expect(row?.channel).toBe('email')
      const payload = row?.payload as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(['code', 'sharedByDisplayName'])
      expect(payload['code']).toMatch(/^\d{6}$/)
      expect(JSON.stringify(payload)).not.toContain(token)
    })

    it('throttles a resend within 60 s, allows one after, and caps sends per share', async () => {
      const { id, token } = await seeder.seedShare(GATED)
      await requestCode(token)
      await requestCode(token)
      expect((await seeder.readShare(id))?.verificationSendCount).toBe(1)

      await forEachSequential(Array.from({ length: EXTERNAL_SHARE_VERIFICATION_MAX_SENDS }), () =>
        withOrg(seeder.orgId, (tx) =>
          tx
            .update(credentialShares)
            .set({ verificationSentAt: new Date(Date.now() - 61_000) })
            .where(eq(credentialShares.id, id))
        ).then(() => requestCode(token))
      )
      expect((await seeder.readShare(id))?.verificationSendCount).toBe(
        EXTERNAL_SHARE_VERIFICATION_MAX_SENDS
      )
    })

    it('a new code invalidates the previous one', async () => {
      const { id, token } = await seeder.seedShare(GATED)
      await requestCode(token)
      const firstCode = await readQueuedVerificationCode(seeder.orgId, seeder.recipientEmail)
      await withOrg(seeder.orgId, (tx) =>
        tx
          .update(credentialShares)
          .set({ verificationSentAt: new Date(Date.now() - 61_000) })
          .where(eq(credentialShares.id, id))
      )
      await requestCode(token)
      const secondCode = await readQueuedVerificationCode(seeder.orgId, seeder.recipientEmail)
      if (!firstCode || !secondCode) throw new Error('expected two queued codes')
      if (firstCode !== secondCode) {
        expect((await confirm(token, firstCode)).statusCode).toBe(422)
      }
      expect((await confirm(token, secondCode)).statusCode).toBe(200)
    })
  })

  describe('confirm route (V4, V7, V8)', () => {
    it('a correct code returns a one-time proof; the same code a second time fails', async () => {
      const { id, token } = await seeder.seedShare(GATED)
      const code = await requestAndReadCode(token)

      const ok = await confirm(token, code)
      expect(ok.statusCode).toBe(200)
      expect(ok.headers['cache-control']).toBe('no-store')
      expect(ok.headers['referrer-policy']).toBe('no-referrer')
      const { proof } = ok.json<{ data: { proof: string } }>().data
      expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/)

      const row = await seeder.readShare(id)
      expect(row?.verificationCodeHash).toBeNull()
      expect(row?.verifiedAt).toBeInstanceOf(Date)
      expect(row?.verificationProofHash).not.toContain(proof)
      expect(row?.verificationAttemptCount).toBe(0)

      const again = await confirm(token, code)
      expect(again.statusCode).toBe(422)
      expect(again.json()).toEqual(FAILED_BODY)
    })

    it('answers one identical 422 for every failure class', async () => {
      const live = await seeder.seedShare(GATED)
      await requestCode(live.token)
      const expiredCode = await seeder.seedShare(GATED)
      await requestCode(expiredCode.token)
      await withOrg(seeder.orgId, (tx) =>
        tx
          .update(credentialShares)
          .set({ verificationCodeExpiresAt: PAST() })
          .where(eq(credentialShares.id, expiredCode.id))
      )

      const tokens = [
        generateAndHashShareToken().rawToken,
        'x',
        (await seeder.seedShare({ ...GATED, status: 'revoked' })).token,
        (await seeder.seedShare({ ...GATED, status: 'viewed' })).token,
        (await seeder.seedShare({ ...GATED, status: 'expired', expiresAt: PAST() })).token,
        (await seeder.seedShare({ ...GATED, lockedAt: new Date(), status: 'revoked' })).token,
        (await seeder.seedShare(GATED)).token, // no code requested
        (await seeder.seedShare()).token, // link-only
        expiredCode.token,
        live.token, // wrong code
      ]
      const responses = await Promise.all(tokens.map((token) => confirm(token, '000000')))
      for (const response of responses) {
        expect(response.statusCode).toBe(422)
        expect(response.json()).toEqual(FAILED_BODY)
        expect(response.headers['cache-control']).toBe('no-store')
      }
      // A malformed body fails the same way.
      const malformed = await post(accessUrl(live.token, CONFIRM), { code: 7 })
      expect(malformed.statusCode).toBe(422)
      expect(malformed.json()).toEqual(FAILED_BODY)
      // An expired code is not a guess against the budget.
      expect((await seeder.readShare(expiredCode.id))?.verificationAttemptCount).toBe(0)
    })

    it('V4: a parallel burst of wrong guesses compares at most five times, then revokes and locks once', async () => {
      const { id, token } = await seeder.seedShare(GATED)
      const code = await requestAndReadCode(token)
      const wrong = code === '999999' ? '999998' : '999999'

      const burst = await Promise.all(
        Array.from({ length: EXTERNAL_SHARE_VERIFICATION_MAX_ATTEMPTS + 7 }, () =>
          confirm(token, wrong)
        )
      )
      for (const response of burst) expect(response.json()).toEqual(FAILED_BODY)

      const row = await seeder.readShare(id)
      expect(row?.verificationAttemptCount).toBe(EXTERNAL_SHARE_VERIFICATION_MAX_ATTEMPTS)
      expect(row?.status).toBe('revoked')
      expect(row?.lockedAt).toBeInstanceOf(Date)
      expect(row?.verificationCodeHash).toBeNull()

      const audits = await withOrg(seeder.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(
            and(
              eq(auditLogEntries.eventType, AuditEvent.CREDENTIAL_SHARE_REVOKED),
              eq(auditLogEntries.resourceId, id)
            )
          )
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]?.actorType).toBe('system')
      expect(audits[0]?.payload).toMatchObject({ reason: 'verification_attempts_exhausted' })
      expect(JSON.stringify(audits[0]?.payload)).not.toContain(code)

      // The right code no longer helps once the share is locked.
      expect((await confirm(token, code)).statusCode).toBe(422)
    })

    it('the budget is per share across codes: a new code does not reset it', async () => {
      const { id, token } = await seeder.seedShare({
        ...GATED,
        verificationAttemptCount: EXTERNAL_SHARE_VERIFICATION_MAX_ATTEMPTS - 1,
      })
      await requestCode(token)
      const code = await readQueuedVerificationCode(seeder.orgId, seeder.recipientEmail)
      expect((await confirm(token, code === '111111' ? '111112' : '111111')).statusCode).toBe(422)
      expect((await seeder.readShare(id))?.lockedAt).toBeInstanceOf(Date)
    })
  })

  describe('reveal proof gate (V8)', () => {
    it('without a proof, or with a wrong one, a gated share answers the plain 404 and counts a losing attempt', async () => {
      const { id, token } = await seeder.seedShare(GATED)
      const unknown = await post(accessUrl(generateAndHashShareToken().rawToken, '/reveal'))
      const missing = await post(accessUrl(token, '/reveal'))
      const wrong = await post(accessUrl(token, '/reveal'), { proof: 'A'.repeat(43) })
      await flushPendingLosingAttempts()

      for (const response of [missing, wrong]) {
        expect(response.statusCode).toBe(404)
        expect(response.json()).toEqual(unknown.json())
      }
      expect((await seeder.readShare(id))?.revealAttemptCount).toBe(2)
    })

    it('with the proof the reveal succeeds once, audits the verified view, and a replay never reveals', async () => {
      const { id, token, proof } = await seedVerified()
      const reveal = await post(accessUrl(token, '/reveal'), { proof })
      expect(reveal.statusCode).toBe(200)
      expect(reveal.json<{ data: { value: string } }>().data.value).toEqual(expect.any(String))

      expect((await seeder.readShare(id))?.status).toBe('viewed')
      const viewed = await withOrg(seeder.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(
            and(
              eq(auditLogEntries.eventType, AuditEvent.CREDENTIAL_SHARE_VIEWED),
              eq(auditLogEntries.resourceId, id)
            )
          )
      )
      expect(viewed[0]?.payload).toMatchObject({ recipientVerified: true })
      expect(JSON.stringify(viewed[0]?.payload)).not.toContain(proof)

      // The share is single use: the same proof now meets a terminal share, never the value.
      const replay = await post(accessUrl(token, '/reveal'), { proof })
      expect(replay.statusCode).toBe(410)
      expect(replay.json<{ code: string }>().code).toBe('share_already_viewed')
    })

    it('a proof older than 15 minutes no longer opens the share', async () => {
      const { id, token, proof } = await seedVerified()
      await withOrg(seeder.orgId, (tx) =>
        tx
          .update(credentialShares)
          .set({ verifiedAt: new Date(Date.now() - 16 * 60_000) })
          .where(eq(credentialShares.id, id))
      )
      expect((await post(accessUrl(token, '/reveal'), { proof })).statusCode).toBe(404)
    })

    it('a link-only share still reveals without a proof', async () => {
      const { token } = await seeder.seedShare()
      expect((await post(accessUrl(token, '/reveal'))).statusCode).toBe(200)
    })
  })

  it('V10: the existing reveal-attempt cap revoke also locks the share and audits it once', async () => {
    const { id, token } = await seeder.seedShare({ status: 'viewed', viewCount: 1 })
    await forEachSequential(Array.from({ length: 6 }), async () => {
      await post(accessUrl(token, '/reveal'))
      await flushPendingLosingAttempts()
    })
    const row = await seeder.readShare(id)
    expect(row?.status).toBe('revoked')
    expect(row?.lockedAt).toBeInstanceOf(Date)
    expect(await seeder.countAuditRows(AuditEvent.CREDENTIAL_SHARE_REVOKED, id)).toBe(1)
  })

  describe('V9: every outcome of both routes is held to the floor', () => {
    async function timed(url: string, payload?: Record<string, unknown>) {
      const started = performance.now()
      const response = await post(url, payload)
      return { response, elapsedMs: performance.now() - started }
    }

    it('send: unknown and live gated shares both wait for the floor', async () => {
      const live = (await seeder.seedShare(GATED)).token
      const unknown = await timed(accessUrl(generateAndHashShareToken().rawToken, SEND))
      const hit = await timed(accessUrl(live, SEND))
      await flushPendingLosingAttempts()
      for (const probe of [unknown, hit]) {
        expect(probe.response.statusCode).toBe(200)
        expect(probe.elapsedMs).toBeGreaterThanOrEqual(MIN_ELAPSED)
      }
    })

    it('confirm: a failure and a success both wait for the floor', async () => {
      const { token } = await seeder.seedShare(GATED)
      const code = await requestAndReadCode(token)
      const failure = await timed(accessUrl(generateAndHashShareToken().rawToken, CONFIRM), {
        code: '000000',
      })
      const success = await timed(accessUrl(token, CONFIRM), { code })
      expect(failure.response.statusCode).toBe(422)
      expect(success.response.statusCode).toBe(200)
      for (const probe of [failure, success]) {
        expect(probe.elapsedMs).toBeGreaterThanOrEqual(MIN_ELAPSED)
      }
    })
  })
})
