import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import nodemailer from 'nodemailer'
import { and, eq, sql } from 'drizzle-orm'
import { register } from 'prom-client'
import { withOrg, withOrgAndUser } from '@project-vault/db'
import { auditLogEntries, notificationQueue } from '@project-vault/db/schema'
import {
  createTestUser,
  deleteTestUser,
  withTestOrg,
  withTwoTestOrgs,
} from '@project-vault/db/test-helpers'
import { AuditEvent } from '@project-vault/shared'
import type { DeliveryProvider, DeliveryProviderSendPayload } from '@project-vault/extension-api'
import {
  createMockBoss,
  getNotificationQueueEntry,
} from '../__tests__/helpers/notification-test-helpers.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  __resetDeliveryProvidersForTests,
  wireExtensionDeliveryProvider,
} from '../lib/delivery-provider.js'
import type { ExtensionState } from '../extensions/loader.js'
import { applyDeliveryStatusUpdate } from '../notifications/delivery-status.js'
import {
  resetEmailTransportForTesting,
  sendEmailNotification,
  setEmailTransportForTesting,
} from './notification-email.js'
import { deliverNotification, wrapDeliverHandler } from './notification-deliver.js'
import {
  deliverInboxNotification,
  insertInboxQueueEntry,
  listInboxEntriesForTest,
  resetEmitterForTesting,
} from './notification-inbox.js'
import {
  claimPendingNotificationEntry,
  markNotificationSendStarted,
  releaseNotificationClaim,
} from './notification-queue-ops.js'
import { runDeliverCatchup } from './notification-deliver-catchup.js'
import { runNotificationDlqCleanup } from './notification-dlq-cleanup.js'
import { NOTIFICATION_MAX_ATTEMPTS } from './notification-worker-common.js'
import { NOTIFICATION_DELIVERY_OUTCOME_UNKNOWN_TOTAL_METRIC_NAME } from './notification-metrics.js'

// Story 70.1 — the exclusive claim (AC1), lease/release/reclaim (AC2), the at-most-once outcome
// for an ambiguous post-send failure (AC5, Decisions 2026-09-30), tenant isolation (AC6) and the
// one-audit-row-per-transition invariant (AC8), all against the real test Postgres as vault_app.

const smtpState = vi.hoisted(() => ({ from: null as string | null }))

vi.mock('../modules/platform-admin/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/platform-admin/service.js')>()
  return {
    ...actual,
    resolveSmtpTransportConfig: vi.fn(async () => ({
      host: 'smtp.test.invalid',
      port: 587,
      secure: false,
      user: null,
      password: null,
      from: smtpState.from,
    })),
  }
})

vi.mock('@project-vault/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@project-vault/db')>()
  return { ...actual, withOrgAndUser: vi.fn(actual.withOrgAndUser) }
})

vi.mock('../notifications/delivery-status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notifications/delivery-status.js')>()
  return { ...actual, applyDeliveryStatusUpdate: vi.fn(actual.applyDeliveryStatusUpdate) }
})

configureAuthIntegrationEnv()

const TEMPLATE_ID = 'security.failed_auth_threshold'
const COMMIT_FAILED = 'commit failed'
const RECIPIENT = 'claim-recipient-70-1@example.com'
const TEMPLATE_PAYLOAD = {
  thresholdType: 'ip',
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 10,
  windowStart: new Date().toISOString(),
  windowEnd: new Date().toISOString(),
  ipAddress: '203.0.113.1',
}

beforeAll(async () => {
  await resetVaultForTest()
  const { initVault } = await import('../modules/vault/key-service.js')
  await initVaultForTest(initVault, 'notification-queue-claim-vault-secret')
})

beforeEach(() => {
  __resetDeliveryProvidersForTests()
  smtpState.from = null
})

afterEach(() => {
  __resetDeliveryProvidersForTests()
  resetEmailTransportForTesting()
  resetEmitterForTesting()
  vi.mocked(applyDeliveryStatusUpdate).mockClear()
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function loadedStateWith(deliveryProvider: Record<string, DeliveryProvider>): ExtensionState {
  return {
    status: 'loaded',
    manifest: { name: 'com.acme.claim-test', apiVersion: '3.25.0', capabilities: [] },
    loadedAt: new Date().toISOString(),
    hooks: { deliveryProvider },
  }
}

function registerProvider(send: DeliveryProvider['send']): void {
  wireExtensionDeliveryProvider(
    loadedStateWith({
      email: { send, verifyWebhookSignature: () => true, parseWebhookEvents: () => [] },
    })
  )
}

async function seedEmailRow(
  orgId: string,
  values: Partial<typeof notificationQueue.$inferInsert> = {}
): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        recipientEmail: RECIPIENT,
        channel: 'email',
        templateId: TEMPLATE_ID,
        payload: TEMPLATE_PAYLOAD,
        status: 'pending',
        ...values,
      })
      .returning({ id: notificationQueue.id })
  )
  if (!row) throw new Error('expected queue row')
  return row.id
}

async function expireLease(orgId: string, queueId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.execute(sql`
      UPDATE notification_queue
         SET claim_expires_at = now() - interval '1 second'
       WHERE id = ${queueId}::uuid
    `)
  )
}

async function readLease(
  orgId: string,
  queueId: string
): Promise<{ claimExpiresAt: unknown; sendStartedAt: unknown }> {
  const rows = await withOrg(orgId, (tx) =>
    tx.execute<{ claim_expires_at: unknown; send_started_at: unknown }>(sql`
      SELECT claim_expires_at, send_started_at FROM notification_queue WHERE id = ${queueId}::uuid
    `)
  )
  const [row] = rows
  return {
    claimExpiresAt: row?.claim_expires_at ?? null,
    sendStartedAt: row?.send_started_at ?? null,
  }
}

async function countStatusAudits(orgId: string, queueId: string): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ id: auditLogEntries.id })
      .from(auditLogEntries)
      .where(
        and(
          eq(auditLogEntries.eventType, AuditEvent.NOTIFICATION_DELIVERY_STATUS_UPDATED),
          eq(auditLogEntries.resourceId, queueId)
        )
      )
  )
  return rows.length
}

/** Runs `calls` concurrently and releases `gate` only once every call has either entered the
 * gated side effect or already settled — so a racing loser is provably in flight at the same time
 * as the winner, without relying on timing. */
async function runGated(
  calls: Array<() => Promise<void>>,
  entered: () => number,
  gate: { resolve: () => void }
): Promise<PromiseSettledResult<void>[]> {
  let settled = 0
  const running = calls.map((call) =>
    call().finally(() => {
      settled++
    })
  )
  await vi.waitFor(() => expect(entered() + settled).toBeGreaterThanOrEqual(calls.length))
  gate.resolve()
  return Promise.allSettled(running)
}

describe('Story 70.1 AC1 — exclusive claim', () => {
  it('provider path: two concurrent sendEmailNotification calls send exactly once', async () => {
    const gate = deferred()
    let entered = 0
    const providerMessageId = `pm-${randomUUID()}`
    const send = vi.fn(async () => {
      entered++
      await gate.promise
      return { providerMessageId }
    })
    registerProvider(send)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)

      const results = await runGated(
        [() => sendEmailNotification(queueId, orgId), () => sendEmailNotification(queueId, orgId)],
        () => entered,
        gate
      )

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
      const row = await getNotificationQueueEntry(orgId, queueId)
      expect(row?.status).toBe('sent')
      expect(row?.providerMessageId).toBe(providerMessageId)
      expect(row?.attemptCount).toBe(1)
      // AC8 — exactly one status audit row; the losing caller wrote none.
      expect(await countStatusAudits(orgId, queueId)).toBe(1)
    })
  })

  it('SMTP path: two concurrent calls call sendMail exactly once, row delivered', async () => {
    const gate = deferred()
    let entered = 0
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sendMail = vi.spyOn(transport, 'sendMail').mockImplementation(async () => {
      entered++
      await gate.promise
      return {} as never
    })
    setEmailTransportForTesting(transport)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)

      await runGated(
        [() => sendEmailNotification(queueId, orgId), () => sendEmailNotification(queueId, orgId)],
        () => entered,
        gate
      )

      expect(sendMail).toHaveBeenCalledTimes(1)
      const row = await getNotificationQueueEntry(orgId, queueId)
      expect(row?.status).toBe('delivered')
      expect(row?.attemptCount).toBe(1)
      expect(await countStatusAudits(orgId, queueId)).toBe(1)
    })
  })

  it('mixed path: sendEmailNotification racing deliverNotification sends once', async () => {
    const gate = deferred()
    let entered = 0
    const send = vi.fn(async () => {
      entered++
      await gate.promise
      return { providerMessageId: `pm-${randomUUID()}` }
    })
    registerProvider(send)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)

      await runGated(
        [() => sendEmailNotification(queueId, orgId), () => deliverNotification(queueId, orgId)],
        () => entered,
        gate
      )

      expect(send).toHaveBeenCalledTimes(1)
      expect((await getNotificationQueueEntry(orgId, queueId))?.status).toBe('sent')
    })
  })

  it('inbox: two concurrent deliveries write exactly one notification_inbox row', async () => {
    const userId = await createTestUser('claim-inbox-70-1')
    try {
      await withTestOrg(async ({ orgId }) => {
        const queueId = await insertInboxQueueEntry(orgId, userId, {
          payload: { ...TEMPLATE_PAYLOAD, severity: 'warning' },
        })
        const emitter = new EventEmitter()

        await Promise.allSettled([
          deliverInboxNotification(queueId, orgId, emitter),
          deliverInboxNotification(queueId, orgId, emitter),
        ])

        expect(await listInboxEntriesForTest(orgId, userId)).toHaveLength(1)
        const row = await getNotificationQueueEntry(orgId, queueId)
        expect(row?.status).toBe('delivered')
        expect(row?.attemptCount).toBe(1)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('20 concurrent claims of one row: exactly one wins, attempt_count = 1', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)

      const results = await Promise.all(
        Array.from({ length: 20 }, () => claimPendingNotificationEntry(queueId, orgId))
      )

      expect(results.filter((r) => r !== null)).toHaveLength(1)
      const winner = results.find((r) => r !== null)
      // The post-update row: attemptCount is the number of this attempt.
      expect(winner?.attemptCount).toBe(1)
      expect((await getNotificationQueueEntry(orgId, queueId))?.attemptCount).toBe(1)
    })
  })

  it('a row with a live lease is not claimable and is not touched', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)
      const first = await claimPendingNotificationEntry(queueId, orgId)
      expect(first).not.toBeNull()
      const afterFirst = await getNotificationQueueEntry(orgId, queueId)

      expect(await claimPendingNotificationEntry(queueId, orgId)).toBeNull()

      const afterSecond = await getNotificationQueueEntry(orgId, queueId)
      expect(afterSecond?.attemptCount).toBe(1)
      expect(afterSecond?.lastAttemptAt?.getTime()).toBe(afterFirst?.lastAttemptAt?.getTime())
      expect((await readLease(orgId, queueId)).claimExpiresAt).not.toBeNull()
    })
  })

  it.each(['sent', 'delivered', 'failed', 'suppressed', 'bounced'] as const)(
    'a %s row is not claimable and is not written',
    async (status) => {
      await withTestOrg(async ({ orgId }) => {
        const queueId = await seedEmailRow(orgId, { status })
        expect(await claimPendingNotificationEntry(queueId, orgId)).toBeNull()
        const row = await getNotificationQueueEntry(orgId, queueId)
        expect(row?.attemptCount).toBe(0)
        expect(row?.lastAttemptAt).toBeNull()
      })
    }
  )

  it('a row whose deliver_at is in the future (DB clock) is not claimable', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId, { deliverAt: new Date(Date.now() + 3_600_000) })
      expect(await claimPendingNotificationEntry(queueId, orgId)).toBeNull()
      expect((await getNotificationQueueEntry(orgId, queueId))?.attemptCount).toBe(0)
    })
  })

  it('a row at NOTIFICATION_MAX_ATTEMPTS is not claimable (no 6th attempt)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId, { attemptCount: NOTIFICATION_MAX_ATTEMPTS })
      expect(await claimPendingNotificationEntry(queueId, orgId)).toBeNull()
      const row = await getNotificationQueueEntry(orgId, queueId)
      expect(row?.attemptCount).toBe(NOTIFICATION_MAX_ATTEMPTS)
      expect(row?.lastAttemptAt).toBeNull()
    })
  })

  it('an unknown id is not claimable', async () => {
    await withTestOrg(async ({ orgId }) => {
      expect(await claimPendingNotificationEntry(randomUUID(), orgId)).toBeNull()
    })
  })
})

describe('Story 70.1 AC2 — lease, fenced release, reclaim', () => {
  it('a thrown provider send releases the claim and the immediate retry sends (attemptNumber 2)', async () => {
    const send = vi
      .fn<(payload: DeliveryProviderSendPayload) => Promise<{ providerMessageId: string }>>()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ providerMessageId: `pm-${randomUUID()}` })
    registerProvider(send)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)

      await expect(sendEmailNotification(queueId, orgId)).rejects.toThrow('provider unavailable')
      const afterFailure = await getNotificationQueueEntry(orgId, queueId)
      expect(afterFailure?.status).toBe('pending')
      expect(afterFailure?.attemptCount).toBe(1)
      expect(await readLease(orgId, queueId)).toEqual({ claimExpiresAt: null, sendStartedAt: null })

      await sendEmailNotification(queueId, orgId)

      expect(send).toHaveBeenCalledTimes(2)
      // AC4 — same idempotency key on the retry, attemptNumber is the post-claim count.
      expect(send.mock.calls[0]?.[0]).toMatchObject({ queueRowId: queueId, attemptNumber: 1 })
      expect(send.mock.calls[1]?.[0]).toMatchObject({ queueRowId: queueId, attemptNumber: 2 })
      const row = await getNotificationQueueEntry(orgId, queueId)
      expect(row?.status).toBe('sent')
      expect(row?.attemptCount).toBe(2)
    })
  })

  it('crash before send: a live lease blocks the send; once expired the row is sent exactly once', async () => {
    const send = vi.fn(async () => ({ providerMessageId: `pm-${randomUUID()}` }))
    registerProvider(send)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)
      // Simulates a worker that claimed and then died before reaching send().
      expect(await claimPendingNotificationEntry(queueId, orgId)).not.toBeNull()

      await sendEmailNotification(queueId, orgId)
      expect(send).not.toHaveBeenCalled()

      await expireLease(orgId, queueId)
      await sendEmailNotification(queueId, orgId)

      expect(send).toHaveBeenCalledTimes(1)
      const row = await getNotificationQueueEntry(orgId, queueId)
      expect(row?.status).toBe('sent')
      expect(row?.attemptCount).toBe(2)
    })
  })

  it('inbox: a failed inbox transaction releases the claim; the retry writes exactly one inbox row', async () => {
    const userId = await createTestUser('claim-inbox-retry-70-1')
    try {
      await withTestOrg(async ({ orgId }) => {
        const queueId = await insertInboxQueueEntry(orgId, userId, {
          payload: { ...TEMPLATE_PAYLOAD, severity: 'warning' },
        })
        vi.mocked(withOrgAndUser).mockImplementationOnce(async () => {
          throw new Error('inbox insert failed')
        })
        const emitter = new EventEmitter()

        await expect(deliverInboxNotification(queueId, orgId, emitter)).rejects.toThrow(
          'inbox insert failed'
        )
        expect(await readLease(orgId, queueId)).toEqual({
          claimExpiresAt: null,
          sendStartedAt: null,
        })

        await deliverInboxNotification(queueId, orgId, emitter)

        expect(await listInboxEntriesForTest(orgId, userId)).toHaveLength(1)
        const row = await getNotificationQueueEntry(orgId, queueId)
        expect(row?.status).toBe('delivered')
        expect(row?.attemptCount).toBe(2)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('fencing: a stale attempt cannot release a newer attempt’s lease', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)
      expect((await claimPendingNotificationEntry(queueId, orgId))?.attemptCount).toBe(1)
      await expireLease(orgId, queueId)
      expect((await claimPendingNotificationEntry(queueId, orgId))?.attemptCount).toBe(2)

      await releaseNotificationClaim(queueId, orgId, 1)

      expect((await readLease(orgId, queueId)).claimExpiresAt).not.toBeNull()
      expect(await claimPendingNotificationEntry(queueId, orgId)).toBeNull()
    })
  })
})

describe('Story 70.1 AC5 — at-most-once for an ambiguous post-send outcome (DW-252)', () => {
  it('provider path: a failed `sent` commit after a resolved send is never re-sent; DLQ fails it as outcome-unknown', async () => {
    const seenKeys = new Set<string>()
    const send = vi.fn(async (payload: DeliveryProviderSendPayload) => {
      seenKeys.add(payload.queueRowId)
      return { providerMessageId: `pm-${payload.queueRowId}` }
    })
    registerProvider(send)
    vi.mocked(applyDeliveryStatusUpdate).mockImplementationOnce(async () => {
      throw new Error(COMMIT_FAILED)
    })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)

      await expect(sendEmailNotification(queueId, orgId)).rejects.toThrow(COMMIT_FAILED)
      const afterFailure = await getNotificationQueueEntry(orgId, queueId)
      expect(afterFailure?.status).toBe('pending')
      expect(afterFailure?.attemptCount).toBe(1)
      const lease = await readLease(orgId, queueId)
      expect(lease.sendStartedAt).not.toBeNull()
      expect(lease.claimExpiresAt).not.toBeNull()
      // AC8 — the rolled-back commit wrote no audit row.
      expect(await countStatusAudits(orgId, queueId)).toBe(0)

      // The pg-boss retry: no re-send.
      await sendEmailNotification(queueId, orgId)
      expect(send).toHaveBeenCalledTimes(1)

      // Even after the lease expires: never re-claimed, never re-enqueued.
      await expireLease(orgId, queueId)
      await sendEmailNotification(queueId, orgId)
      expect(send).toHaveBeenCalledTimes(1)
      const { boss, send: bossSend } = createMockBoss()
      await boss.start()
      await runDeliverCatchup(boss, logger)
      expect(bossSend.mock.calls.filter((c) => c[1]?.notificationQueueId === queueId)).toHaveLength(
        0
      )

      const before = await outcomeUnknownCount('email')
      await runNotificationDlqCleanup(logger)

      const row = await getNotificationQueueEntry(orgId, queueId)
      expect(row?.status).toBe('failed')
      expect(send).toHaveBeenCalledTimes(1)
      expect(seenKeys.size).toBe(1)
      expect(await outcomeUnknownCount('email')).toBe(before + 1)
      const outcomeLogs = logger.error.mock.calls.filter(
        (call) =>
          (call[0] as { eventType?: string }).eventType ===
            'notification.delivery_outcome_unknown' &&
          (call[0] as { notificationQueueId?: string }).notificationQueueId === queueId
      )
      expect(outcomeLogs).toHaveLength(1)
      expect(outcomeLogs[0]?.[0]).toMatchObject({
        notificationQueueId: queueId,
        templateId: TEMPLATE_ID,
        channel: 'email',
        attemptNumber: 1,
      })
      // AC9 — recipient-free.
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(RECIPIENT)
      // The DLQ's own ordinary dead-letter event must not double-report this row.
      expect(
        logger.error.mock.calls.filter(
          (call) =>
            (call[0] as { eventType?: string }).eventType ===
              'notification.dlq_cleanup.entry_failed' &&
            (call[0] as { notificationQueueId?: string }).notificationQueueId === queueId
        )
      ).toHaveLength(0)
    })
  })

  it('crash while the send is in flight: no path re-sends; DLQ fails it after lease expiry', async () => {
    const send = vi.fn(async () => ({ providerMessageId: `pm-${randomUUID()}` }))
    registerProvider(send)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)
      const claimed = await claimPendingNotificationEntry(queueId, orgId)
      if (!claimed) throw new Error('expected claim')
      // The worker marked the send as started and then died mid-call.
      await markNotificationSendStarted(queueId, orgId, claimed.attemptCount)
      await expireLease(orgId, queueId)

      await sendEmailNotification(queueId, orgId)
      await deliverNotification(queueId, orgId)
      expect(send).not.toHaveBeenCalled()

      await runNotificationDlqCleanup()
      expect((await getNotificationQueueEntry(orgId, queueId))?.status).toBe('failed')
    })
  })

  it('a stale attempt cannot mark a newer attempt’s send as started', async () => {
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)
      await claimPendingNotificationEntry(queueId, orgId)
      await expireLease(orgId, queueId)
      await claimPendingNotificationEntry(queueId, orgId)

      await expect(markNotificationSendStarted(queueId, orgId, 1)).rejects.toThrow()
      expect((await readLease(orgId, queueId)).sendStartedAt).toBeNull()
    })
  })

  it('SMTP path: a failed `delivered` commit after sendMail is never re-sent; Message-ID is deterministic', async () => {
    smtpState.from = 'Project Vault <alerts@vault.example.com>'
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sendMail = vi.spyOn(transport, 'sendMail')
    setEmailTransportForTesting(transport)
    vi.mocked(applyDeliveryStatusUpdate).mockImplementationOnce(async () => {
      throw new Error(COMMIT_FAILED)
    })

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)

      await expect(sendEmailNotification(queueId, orgId)).rejects.toThrow(COMMIT_FAILED)
      await sendEmailNotification(queueId, orgId)
      await expireLease(orgId, queueId)
      await sendEmailNotification(queueId, orgId)

      expect(sendMail).toHaveBeenCalledTimes(1)
      expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
        messageId: `<pv-nq-${queueId}@vault.example.com>`,
      })
    })
  })

  it('SMTP Message-ID falls back to project-vault.invalid with no usable from-address', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sendMail = vi.spyOn(transport, 'sendMail')
    setEmailTransportForTesting(transport)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailRow(orgId)
      await sendEmailNotification(queueId, orgId)
      expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
        messageId: `<pv-nq-${queueId}@project-vault.invalid>`,
      })
      expect((await getNotificationQueueEntry(orgId, queueId))?.status).toBe('delivered')
    })
  })
})

describe('Story 70.1 AC3 — catch-up jobs executed through the real handlers', () => {
  // Code review 70-1: AC3's "end-to-end-ish" case. Every job runDeliverCatchup captures is
  // executed through the real notification/deliver handler, each one twice and all at once (the
  // shape of a pg-boss expiry-retry or a rolling-deploy duplicate landing alongside the original),
  // and every row is still delivered exactly once. Slack is covered by its own concurrency test in
  // notification-slack.test.ts (its webhook URL is read from env at module load).
  it('one delivery per row when every captured job runs concurrently, duplicates included', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sendMail = vi.spyOn(transport, 'sendMail').mockResolvedValue({} as never)
    setEmailTransportForTesting(transport)
    const userId = await createTestUser('claim-catchup-e2e-70-1')
    const stale = new Date(Date.now() - 10 * 60 * 1000)
    try {
      await withTestOrg(async ({ orgId }) => {
        const emailIds = [
          await seedEmailRow(orgId, { createdAt: stale }),
          await seedEmailRow(orgId, { createdAt: stale }),
        ]
        const inboxId = await insertInboxQueueEntry(orgId, userId, {
          payload: { ...TEMPLATE_PAYLOAD, severity: 'warning' },
          createdAt: stale,
        })

        const { boss, send: bossSend } = createMockBoss()
        await boss.start()
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
        await runDeliverCatchup(boss, logger)
        const jobs = bossSend.mock.calls
          .filter((call) => call[1]?.orgId === orgId)
          .map((call, index) => ({ name: call[0] as string, id: `job-${index}`, data: call[1] }))
        expect(jobs.map((job) => job.data.notificationQueueId).sort()).toEqual(
          [...emailIds, inboxId].sort()
        )
        expect(new Set(jobs.map((job) => job.name))).toEqual(new Set(['notification/deliver']))

        const handler = wrapDeliverHandler(logger, new EventEmitter())
        const results = await Promise.allSettled(
          [...jobs, ...jobs].map((job) => handler({ id: job.id, data: job.data }))
        )
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true)

        expect(sendMail).toHaveBeenCalledTimes(emailIds.length)
        for (const emailId of emailIds) {
          const row = await getNotificationQueueEntry(orgId, emailId)
          expect(row?.status).toBe('delivered')
          expect(row?.attemptCount).toBe(1)
        }
        expect(await listInboxEntriesForTest(orgId, userId)).toHaveLength(1)
        expect((await getNotificationQueueEntry(orgId, inboxId))?.status).toBe('delivered')
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})

describe('Story 70.1 AC6 — tenant isolation', () => {
  it('claim and release under the wrong org change nothing', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const rowA = await seedEmailRow(orgAId)

      expect(await claimPendingNotificationEntry(rowA, orgBId)).toBeNull()
      expect((await getNotificationQueueEntry(orgAId, rowA))?.attemptCount).toBe(0)
      expect((await readLease(orgAId, rowA)).claimExpiresAt).toBeNull()

      expect(await claimPendingNotificationEntry(rowA, orgAId)).not.toBeNull()
      await releaseNotificationClaim(rowA, orgBId, 1)
      expect((await readLease(orgAId, rowA)).claimExpiresAt).not.toBeNull()
    })
  })
})

async function outcomeUnknownCount(channel: string): Promise<number> {
  const metric = register.getSingleMetric(NOTIFICATION_DELIVERY_OUTCOME_UNKNOWN_TOTAL_METRIC_NAME)
  if (!metric) return 0
  const { values } = await metric.get()
  return values.find((v) => v.labels.channel === channel)?.value ?? 0
}
