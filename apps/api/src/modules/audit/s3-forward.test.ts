import { gunzipSync } from 'node:zlib'
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditForwardingConfig, auditLogEntries } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { configureForwarding } from './forwarding.js'
import {
  nextDayToForward,
  runS3ForwardDaily,
  AUDIT_S3_MAX_CONSECUTIVE_FAILURES,
  type S3PutObjectFn,
} from './s3-forward.js'

const TEST_PASSPHRASE = 'audit-s3-forward-test-passphrase'

async function bootVault(): Promise<void> {
  const { initVault } = await bootstrapRouteIntegrationTest()
  await resetVaultForTest()
  await initVaultForTest(initVault, TEST_PASSPHRASE)
}

function utcDateString(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  return date.toISOString().slice(0, 10)
}

async function insertRowOnDay(orgId: string, eventType: string, dayString: string): Promise<void> {
  const createdAt = new Date(`${dayString}T12:00:00.000Z`)
  await withOrg(orgId, (tx) =>
    tx.insert(auditLogEntries).values({
      orgId,
      actorType: 'system',
      eventType,
      payload: {},
      keyVersion: 1,
      hmac: 'a'.repeat(64),
      createdAt,
    })
  )
}

async function configureS3(orgId: string, overrides: { endpoint?: string } = {}): Promise<void> {
  await withOrg(orgId, (tx) =>
    configureForwarding(tx, orgId, {
      type: 's3',
      config: {
        bucket: 'compliance-bucket',
        prefix: 'org-abc/',
        region: 'us-east-1',
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'super-secret',
        ...overrides,
      },
    })
  )
}

function scopedPutObject(
  orgId: string,
  uploads: { key: string; body: Buffer }[],
  shouldFail: (day: string) => boolean = () => false
): S3PutObjectFn {
  return async (input) => {
    if (!input.key.startsWith('org-abc/')) return // belongs to a different test's org — ignore
    const day = input.key.replace('org-abc/', '').replace('.jsonl.gz', '')
    if (shouldFail(day)) throw new Error('simulated upload failure')
    uploads.push({ key: input.key, body: input.body })
  }
}

describe('nextDayToForward (AC-19)', () => {
  it('returns yesterday when never forwarded before', () => {
    expect(nextDayToForward(null)).toBe(utcDateString(1))
  })

  it('returns s3LastForwardedDate + 1 day otherwise', () => {
    expect(nextDayToForward('2026-07-03')).toBe('2026-07-04')
  })
})

describe.sequential('runS3ForwardDaily (AC-19)', () => {
  it("uploads yesterday's rows as gzipped JSONL and advances the watermark", async () => {
    await bootVault()
    await withTestOrg(async ({ orgId }) => {
      await configureS3(orgId)
      await insertRowOnDay(orgId, 'test.s3.row1', utcDateString(1))
      await insertRowOnDay(orgId, 'test.s3.row2', utcDateString(1))

      const uploads: { key: string; body: Buffer }[] = []
      await runS3ForwardDaily(undefined, scopedPutObject(orgId, uploads))

      expect(uploads).toHaveLength(1)
      expect(uploads[0]?.key).toBe(`org-abc/${utcDateString(1)}.jsonl.gz`)
      const uploadedBody = uploads[0]?.body
      expect(uploadedBody).toBeDefined()
      const jsonl = gunzipSync(uploadedBody as Buffer).toString('utf8')
      expect(jsonl.split('\n')).toHaveLength(2)

      const [config] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(config?.s3LastForwardedDate).toBe(utcDateString(1))
      expect(config?.s3ConsecutiveFailureCount).toBe(0)
    })
  })

  it('advances the watermark with no upload when the day has zero rows', async () => {
    await withTestOrg(async ({ orgId }) => {
      await configureS3(orgId)
      const uploads: { key: string; body: Buffer }[] = []
      await runS3ForwardDaily(undefined, scopedPutObject(orgId, uploads))

      expect(uploads).toHaveLength(0)
      const [config] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(config?.s3LastForwardedDate).toBe(utcDateString(1))
    })
  })

  it('retries the same failed day on the next run rather than skipping ahead (AC-19)', async () => {
    await withTestOrg(async ({ orgId }) => {
      await configureS3(orgId)
      await insertRowOnDay(orgId, 'test.s3.fail-day', utcDateString(1))

      const uploads: { key: string; body: Buffer }[] = []
      await runS3ForwardDaily(
        undefined,
        scopedPutObject(orgId, uploads, () => true)
      )

      let [config] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(config?.s3LastForwardedDate).toBeNull()
      expect(config?.s3ConsecutiveFailureCount).toBe(1)

      // Next run: no longer fails — must retry the SAME day (yesterday), not skip to "today".
      await runS3ForwardDaily(
        undefined,
        scopedPutObject(orgId, uploads, () => false)
      )
      ;[config] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(config?.s3LastForwardedDate).toBe(utcDateString(1))
      expect(uploads).toHaveLength(1)
    })
  })

  it(`auto-disables after ${AUDIT_S3_MAX_CONSECUTIVE_FAILURES} consecutive failed days`, async () => {
    await withTestOrg(async ({ orgId }) => {
      await configureS3(orgId)
      await insertRowOnDay(orgId, 'test.s3.always-fails', utcDateString(1))

      for (let i = 0; i < AUDIT_S3_MAX_CONSECUTIVE_FAILURES; i += 1) {
        await runS3ForwardDaily(
          undefined,
          scopedPutObject(orgId, [], () => true)
        )
      }

      const [config] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(config?.enabled).toBe(false)
      expect(config?.s3ConsecutiveFailureCount).toBe(AUDIT_S3_MAX_CONSECUTIVE_FAILURES)
    })
  })

  it('supports a Minio-style custom endpoint', async () => {
    await withTestOrg(async ({ orgId }) => {
      // A public IP-literal stand-in for a Minio endpoint — assertPublicHostname (called at
      // configure-time, D4) performs a real DNS lookup, so a fabricated hostname would fail
      // resolution; a literal public IP resolves without a network round-trip.
      await configureS3(orgId, { endpoint: 'https://93.184.216.34:9000' })
      await insertRowOnDay(orgId, 'test.s3.minio', utcDateString(1))

      let capturedEndpoint: string | undefined
      await runS3ForwardDaily(undefined, async (input) => {
        if (!input.key.startsWith('org-abc/')) return
        capturedEndpoint = input.endpoint
      })

      expect(capturedEndpoint).toBe('https://93.184.216.34:9000')
    })
  })
})
