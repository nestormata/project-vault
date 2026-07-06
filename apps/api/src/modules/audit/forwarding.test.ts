import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditForwardingConfig, auditLogEntries } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { withSecret } from '@project-vault/crypto'
import {
  configureForwarding,
  runWebhookForwardCatchup,
  AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES,
} from './forwarding.js'
import { UnsafeForwardingUrlError } from '../../lib/safe-fetch.js'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const TEST_PASSPHRASE = 'audit-forwarding-test-passphrase'
const WEBHOOK_URL = 'https://93.184.216.34/ingest'
const S3_BUCKET = 'compliance-bucket'

async function bootVault(): Promise<void> {
  const { initVault } = await bootstrapRouteIntegrationTest()
  await resetVaultForTest()
  await initVaultForTest(initVault, TEST_PASSPHRASE)
}

// Monotonically increasing per-process counter so rows inserted in quick succession within a
// single test get strictly distinct `created_at` values — without this, two inserts landing on
// the same microsecond would make the (created_at, id) watermark-cursor ordering depend on
// random UUID tie-breaking instead of insertion order, making "stops at the first failure"-style
// assertions non-deterministic.
let createdAtCounter = 0
function nextCreatedAt(): Date {
  createdAtCounter += 1
  return new Date(Date.now() + createdAtCounter * 10)
}

async function insertAuditRow(orgId: string, eventType: string): Promise<{ id: string }> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(auditLogEntries)
      .values({
        orgId,
        actorType: 'system',
        eventType,
        payload: {},
        keyVersion: 1,
        hmac: 'a'.repeat(64),
        createdAt: nextCreatedAt(),
      })
      .returning({ id: auditLogEntries.id })
  )
  if (!row) throw new Error('expected row')
  return row
}

describe.sequential('configureForwarding (AC-17)', () => {
  it('upserts a webhook config, encrypts the secret, never stores it plaintext', async () => {
    await bootVault()
    await withTestOrg(async ({ orgId }) => {
      const result = await withOrg(orgId, (tx) =>
        configureForwarding(tx, orgId, {
          type: 'webhook',
          config: { url: WEBHOOK_URL, secretHeader: 'wh_sec_test123' },
        })
      )
      expect(result).toMatchObject({ type: 'webhook', enabled: true })

      const [row] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(row?.webhookUrl).toBe('https://93.184.216.34/ingest')
      expect(JSON.stringify(row?.webhookSecretEncrypted)).not.toContain('wh_sec_test123')
      const decrypted = await withSecret(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        row?.webhookSecretEncrypted as any,
        (plaintext) => Promise.resolve(plaintext.toString('utf8'))
      )
      expect(decrypted).toBe('wh_sec_test123')
    })
  })

  it('rejects a private/loopback webhook url with UnsafeForwardingUrlError', async () => {
    await withTestOrg(async ({ orgId }) => {
      await expect(
        withOrg(orgId, (tx) =>
          configureForwarding(tx, orgId, {
            type: 'webhook',
            config: { url: 'https://169.254.169.254/latest/meta-data/', secretHeader: 'x' },
          })
        )
      ).rejects.toThrow(UnsafeForwardingUrlError)
    })
  })

  it('rejects an s3 config whose endpoint resolves to a private address', async () => {
    await withTestOrg(async ({ orgId }) => {
      await expect(
        withOrg(orgId, (tx) =>
          configureForwarding(tx, orgId, {
            type: 's3',
            config: {
              bucket: S3_BUCKET,
              region: 'us-east-1',
              accessKeyId: 'AKIA...',
              secretAccessKey: 'secret',
              endpoint: 'http://169.254.169.254/',
            },
          })
        )
      ).rejects.toThrow()
    })
  })

  it('switching from webhook to s3 clears the prior webhook fields, not left stale (AC-17)', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) =>
        configureForwarding(tx, orgId, {
          type: 'webhook',
          config: { url: WEBHOOK_URL, secretHeader: 'wh_sec' },
        })
      )

      await withOrg(orgId, (tx) =>
        configureForwarding(tx, orgId, {
          type: 's3',
          config: {
            bucket: S3_BUCKET,
            region: 'us-east-1',
            accessKeyId: 'AKIA...',
            secretAccessKey: 'secret',
          },
        })
      )

      const [row] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(row?.type).toBe('s3')
      expect(row?.webhookUrl).toBeNull()
      expect(row?.webhookSecretEncrypted).toBeNull()
      expect(row?.s3Bucket).toBe('compliance-bucket')
    })
  })
})

describe.sequential('runWebhookForwardCatchup (AC-18)', () => {
  it('delivers rows in order, advancing the cursor only after each 2xx', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) =>
        configureForwarding(tx, orgId, {
          type: 'webhook',
          config: { url: WEBHOOK_URL, secretHeader: 'wh_sec' },
        })
      )
      const row1 = await insertAuditRow(orgId, 'test.webhook.1')
      const row2 = await insertAuditRow(orgId, 'test.webhook.2')
      const row3 = await insertAuditRow(orgId, 'test.webhook.3')

      const delivered: string[] = []
      await runWebhookForwardCatchup(undefined, async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}') as { id: string }
        delivered.push(body.id)
        return { status: 200, ok: true }
      })

      expect(delivered).toEqual([row1.id, row2.id, row3.id])
      const [config] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(config?.lastForwardedId).toBe(row3.id)
      expect(config?.consecutiveFailureCount).toBe(0)
    })
  })

  it('stops at the first failure — later rows are not attempted this tick (AC-18 edge case)', async () => {
    await withTestOrg(async ({ orgId }) => {
      await withOrg(orgId, (tx) =>
        configureForwarding(tx, orgId, {
          type: 'webhook',
          config: { url: WEBHOOK_URL, secretHeader: 'wh_sec' },
        })
      )
      const row1 = await insertAuditRow(orgId, 'test.webhook.a')
      const row2 = await insertAuditRow(orgId, 'test.webhook.b')
      await insertAuditRow(orgId, 'test.webhook.c')

      // fetchAllOrgIds() (used internally) iterates every org ever created by this whole test
      // suite — filter the mock's captured deliveries down to this test's own org so an earlier
      // test's org/rows sharing the same DB don't pollute these assertions.
      const delivered: string[] = []
      await runWebhookForwardCatchup(undefined, async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}') as { id: string; orgId: string }
        if (body.orgId !== orgId) return { status: 200, ok: true }
        delivered.push(body.id)
        if (body.id === row2.id) return { status: 500, ok: false }
        return { status: 200, ok: true }
      })

      expect(delivered).toEqual([row1.id, row2.id])

      const [config] = await withOrg(orgId, (tx) =>
        tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
      )
      expect(config?.lastForwardedId).toBe(row1.id)
      expect(config?.consecutiveFailureCount).toBe(1)

      // Next tick retries starting from row2, not skipping ahead.
      const secondTickDelivered: string[] = []
      await runWebhookForwardCatchup(undefined, async (_url, init) => {
        const body = JSON.parse(init.body ?? '{}') as { id: string; orgId: string }
        if (body.orgId !== orgId) return { status: 200, ok: true }
        secondTickDelivered.push(body.id)
        return { status: 200, ok: true }
      })
      expect(secondTickDelivered[0]).toBe(row2.id)
    })
  })

  it(
    `auto-disables after ${AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES} consecutive failures on the ` +
      'same row (AC-18)',
    async () => {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          configureForwarding(tx, orgId, {
            type: 'webhook',
            config: { url: WEBHOOK_URL, secretHeader: 'wh_sec' },
          })
        )
        await insertAuditRow(orgId, 'test.webhook.always-fails')

        // Scoped to this test's own org — other orgs sharing the DB (fetchAllOrgIds iterates
        // all of them) must not be failed by this mock or pollute the attempt count.
        let attempts = 0
        const scopedFailDeliver = async (
          _url: string,
          init: { body?: string }
        ): Promise<{ status: number; ok: boolean }> => {
          const body = JSON.parse(init.body ?? '{}') as { orgId: string }
          if (body.orgId !== orgId) return { status: 200, ok: true }
          attempts += 1
          return { status: 500, ok: false }
        }

        for (let i = 0; i < AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES; i += 1) {
          await runWebhookForwardCatchup(undefined, scopedFailDeliver)
        }
        expect(attempts).toBe(AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES)

        const [config] = await withOrg(orgId, (tx) =>
          tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, orgId))
        )
        expect(config?.enabled).toBe(false)

        // An 11th tick makes no further attempt — the org is disabled.
        await runWebhookForwardCatchup(undefined, scopedFailDeliver)
        expect(attempts).toBe(AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES)
      })
    }
  )

  it('skips orgs with no config or a disabled config', async () => {
    await withTestOrg(async ({ orgId }) => {
      await insertAuditRow(orgId, 'test.webhook.no-config')
      // No throw, no-op. A mock deliver is still injected — other orgs created by earlier tests
      // in this suite may have real enabled webhook configs, and this call iterates ALL orgs
      // (fetchAllOrgIds), so a real safeFetchExternal default here would make live network calls.
      await expect(
        runWebhookForwardCatchup(undefined, async () => ({ status: 200, ok: true }))
      ).resolves.toBeUndefined()
    })
  })
})
