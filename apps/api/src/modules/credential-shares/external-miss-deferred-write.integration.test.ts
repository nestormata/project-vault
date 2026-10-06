import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { AuditEvent } from '@project-vault/shared'
import { bootstrapRouteIntegrationTest } from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { forEachSequential } from '../../lib/for-each-sequential.js'
import { bootCredentialRouteApp } from '../credentials/credential-route-test-helpers.js'
import { flushPendingLosingAttempts, revealExternalShare } from './external-service.js'
import {
  createExternalShareSeeder,
  type ExternalShareSeeder,
  type ShareOverrides,
} from './external-share-test-helpers.js'
import { EXTERNAL_SHARE_MAX_REVEAL_ATTEMPTS, EXTERNAL_SHARE_MISS_FLOOR_MS } from './schema.js'
import { generateAndHashShareToken } from './service.js'
import { shareRevealFailureBody } from './reveal-response.js'

/**
 * Story 65.4 AC4 — the AC-22 attempt cap still holds now that a miss answers from the read and
 * writes its attempt after the response. Real DB, real routes; `flushPendingLosingAttempts()` is
 * the barrier a test uses before reading the counter. Deterministic (no timing statistics): the
 * statistical evidence lives in `external-timing.integration.test.ts`.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'external-deferred',
  orgNamePrefix: 'External Deferred Org',
})

const PAST = () => new Date(Date.now() - 60_000)
const CAP = EXTERNAL_SHARE_MAX_REVEAL_ATTEMPTS
const BURST = CAP + 3

describe('external share deferred losing-attempt write (Story 65.4 AC4)', () => {
  let app: TestApp
  let seeder: ExternalShareSeeder
  let ipCounter = 0

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'external-deferred-passphrase')
    seeder = await createExternalShareSeeder(app, registerOwner, 'deferred')
  }, 120_000)

  afterAll(async () => {
    await flushPendingLosingAttempts()
    await app.close()
    await resetVaultForTest()
  })

  /** One reveal POST from its own source address, so the per-IP route limit never interferes. */
  async function reveal(token: string) {
    ipCounter += 1
    return app.inject({
      method: 'POST',
      url: `/api/v1/external-shares/access/${token}/reveal`,
      remoteAddress: `10.1.${(ipCounter >> 8) & 255}.${ipCounter & 255}`,
    })
  }

  async function seedAndBurst(overrides: ShareOverrides, size: number) {
    const { id, token } = await seeder.seedShare(overrides)
    const responses = await Promise.all(Array.from({ length: size }, () => reveal(token)))
    await flushPendingLosingAttempts()
    return { id, responses, after: await seeder.readShare(id) }
  }

  it('sequential losing attempts on a viewed share count one each and revoke once the cap is crossed', async () => {
    const { id, token } = await seeder.seedShare({ status: 'viewed', viewCount: 1 })
    const codes: string[] = []
    await forEachSequential(Array.from({ length: CAP + 1 }), async () => {
      const response = await reveal(token)
      expect(response.statusCode).toBe(410)
      const body = response.json<{ code: string }>()
      expect(JSON.stringify(body)).not.toMatch(/attempt|remaining/i)
      codes.push(body.code)
      await flushPendingLosingAttempts()
    })

    expect(codes).toEqual([
      ...Array.from({ length: CAP }, () => 'share_already_viewed'),
      'share_revoked',
    ])
    const after = await seeder.readShare(id)
    expect(after?.revealAttemptCount).toBe(CAP + 1)
    expect(after?.status).toBe('revoked')
    expect(after?.revokedAt).not.toBeNull()
  })

  it('a revoked share keeps counting without changing its terminal status', async () => {
    const { after, responses } = await seedAndBurst({ status: 'revoked', revokedAt: PAST() }, 3)
    expect(responses.map((r) => r.statusCode)).toEqual([410, 410, 410])
    expect(after?.revealAttemptCount).toBe(3)
    expect(after?.status).toBe('revoked')
  })

  it('a parallel burst on a viewed share ends with the exact count and one revocation', async () => {
    const { after, responses } = await seedAndBurst({ status: 'viewed', viewCount: 1 }, BURST)
    expect(responses.every((r) => r.statusCode === 410)).toBe(true)
    expect(after?.revealAttemptCount).toBe(BURST)
    expect(after?.status).toBe('revoked')
    expect(after?.revokedAt).not.toBeNull()
  })

  it.each([
    ['expired status', { status: 'expired' as const, expiresAt: PAST() }],
    ['superseded', { status: 'superseded' as const, supersededAt: PAST() }],
  ])('a %s share counts every attempt of a burst and writes no audit row', async (_label, seed) => {
    const { id, after, responses } = await seedAndBurst(seed, CAP - 1)
    expect(responses.every((r) => r.statusCode === 410)).toBe(true)
    expect(after?.revealAttemptCount).toBe(CAP - 1)
    expect(after?.status).toBe(seed.status)
    expect(await seeder.countAuditRows(AuditEvent.CREDENTIAL_SHARE_EXPIRED, id)).toBe(0)
  })

  it('an active share past expiresAt is expired by the deferred task with exactly one audit row', async () => {
    const { id, after, responses } = await seedAndBurst(
      { status: 'active', expiresAt: PAST() },
      CAP - 1
    )
    expect(responses.every((r) => r.statusCode === 410)).toBe(true)
    expect(responses.every((r) => r.json<{ code: string }>().code === 'share_expired')).toBe(true)
    expect(after?.status).toBe('expired')
    expect(after?.revealAttemptCount).toBe(CAP - 1)
    expect(await seeder.countAuditRows(AuditEvent.CREDENTIAL_SHARE_EXPIRED, id)).toBe(1)
  })

  it('a share whose field was removed is expired for the caller but never counted', async () => {
    const { id, token } = await seeder.seedShare({ fieldKey: 'no-longer-exists' })
    const response = await reveal(token)
    await flushPendingLosingAttempts()
    expect(response.statusCode).toBe(410)
    expect(response.json<{ code: string }>().code).toBe('share_expired')
    const after = await seeder.readShare(id)
    expect(after?.revealAttemptCount).toBe(0)
    expect(after?.status).toBe('active')
  })

  it('the hit path is unchanged: one transaction claims and audits, no attempt is counted', async () => {
    const { id, token } = await seeder.seedShare()
    const first = await reveal(token)
    await flushPendingLosingAttempts()
    expect(first.statusCode).toBe(200)
    const after = await seeder.readShare(id)
    expect(after?.status).toBe('viewed')
    expect(after?.revealAttemptCount).toBe(0)
    expect(await seeder.countAuditRows(AuditEvent.CREDENTIAL_SHARE_VIEWED, id)).toBe(1)

    const second = await reveal(token)
    await flushPendingLosingAttempts()
    expect(second.statusCode).toBe(410)
    expect((await seeder.readShare(id))?.revealAttemptCount).toBe(1)
  })

  describe('miss floor on the native routes (AC1)', () => {
    // A timer can fire a hair early relative to `performance.now()`.
    const MIN_ELAPSED = EXTERNAL_SHARE_MISS_FLOOR_MS - 15

    async function timed(method: 'GET' | 'POST', token: string) {
      ipCounter += 1
      const started = performance.now()
      const response = await app.inject({
        method,
        url: `/api/v1/external-shares/access/${token}${method === 'POST' ? '/reveal' : ''}`,
        remoteAddress: `10.2.${(ipCounter >> 8) & 255}.${ipCounter & 255}`,
      })
      return { response, elapsedMs: performance.now() - started }
    }

    it('POST: unknown, malformed and revoked tokens all answer after the floor with unchanged bodies', async () => {
      const revoked = await seeder.seedShare({ status: 'revoked', revokedAt: PAST() })
      const unknown = await timed('POST', generateAndHashShareToken().rawToken)
      const malformed = await timed('POST', 'x')
      const dead = await timed('POST', revoked.token)

      for (const probe of [unknown, malformed]) {
        expect(probe.response.statusCode).toBe(404)
        expect(probe.response.json()).toEqual({
          code: 'share_not_found',
          message: 'Share not found',
        })
        expect(probe.elapsedMs).toBeGreaterThanOrEqual(MIN_ELAPSED)
      }
      expect(dead.response.statusCode).toBe(410)
      expect(dead.response.json()).toEqual(shareRevealFailureBody('revoked'))
      expect(dead.elapsedMs).toBeGreaterThanOrEqual(MIN_ELAPSED)
    })

    it('GET: unknown and no-longer-active shares answer after the floor, an active share does not wait', async () => {
      const unknown = await timed('GET', generateAndHashShareToken().rawToken)
      expect(unknown.response.statusCode).toBe(404)
      expect(unknown.elapsedMs).toBeGreaterThanOrEqual(MIN_ELAPSED)

      const viewed = await seeder.seedShare({ status: 'viewed', viewCount: 1 })
      const dead = await timed('GET', viewed.token)
      expect(dead.response.statusCode).toBe(200)
      expect(dead.response.json<{ data: { status: string } }>().data.status).toBe('viewed')
      expect(dead.elapsedMs).toBeGreaterThanOrEqual(MIN_ELAPSED)

      const active = await seeder.seedShare()
      const hit = await timed('GET', active.token)
      expect(hit.response.statusCode).toBe(200)
      expect(hit.elapsedMs).toBeLessThan(EXTERNAL_SHARE_MISS_FLOOR_MS / 2)
    })
  })

  it('the miss answer does not wait for its write: a row lock held by another transaction does not block it', async () => {
    const { id, token } = await seeder.seedShare({ status: 'viewed', viewCount: 1 })
    let release: () => void = () => undefined
    let markLocked: () => void = () => undefined
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve
    })
    const holder = withOrg(seeder.orgId, async (tx) => {
      await tx.execute(sql`SELECT id FROM credential_shares WHERE id = ${id} FOR UPDATE`)
      markLocked()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await locked

    const outcome = await Promise.race([
      revealExternalShare(token),
      sleep(5000).then(() => 'blocked' as const),
    ])
    expect(outcome).toEqual({ status: 'already_viewed' })
    expect((await seeder.readShare(id))?.revealAttemptCount).toBe(0)

    release()
    await holder
    await flushPendingLosingAttempts()
    expect((await seeder.readShare(id))?.revealAttemptCount).toBe(1)
  })
})
