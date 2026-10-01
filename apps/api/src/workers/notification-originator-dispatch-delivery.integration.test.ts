import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { withTestOrg } from '@project-vault/db/test-helpers'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  backdateQueueRow,
  bindAndRun,
  deferred,
  DISPATCH_TEST_MANIFEST,
  readQueueRow,
  registerEmailProvider,
  sentJobsFor,
  startedMockBoss,
} from '../__tests__/helpers/notification-originator-dispatch-helpers.js'
import { __resetDeliveryProvidersForTests } from '../lib/delivery-provider.js'
import { BossService } from '../lib/boss.js'
import {
  __resetNotificationDispatchBossForTests,
  registerNotificationDispatchBoss,
} from '../lib/notification-dispatch-boss.js'
import { buildNotificationOriginatorHost } from '../lib/notification-originator-host.js'
import { resetEmailTransportForTesting } from './notification-email.js'
import { runDeliverCatchup } from './notification-deliver-catchup.js'
import { deliverNotification, wrapDeliverHandler } from './notification-deliver.js'

/**
 * Story 70.2 AC3 (catch-up fallback), AC4 (immediate dispatch + catch-up never double-sends, the
 * 70.1 interplay), AC5 (first send in seconds with no catch-up tick), AC6 (mismatched pair).
 */

configureAuthIntegrationEnv()

const { initVault } = await import('../modules/vault/key-service.js')

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const SENT_STATUSES = ['sent', 'delivered']
const LATENCY_CAP_MS = 30_000
const NEGATIVE_CONTROL_MS = 5_000

function emailParams(label: string) {
  return {
    channel: 'email' as const,
    recipientEmail: `dispatch-${label}@example.com`,
    subject: `Dispatch ${label}`,
    body: `Body ${label}`,
  }
}

/** Catch-up scans every org, so against the shared test DB it would also enqueue unrelated stale
 * rows left by other suites. Forward only this test's own job to the real boss. */
function onlyJobsFor(realBoss: BossService, queueId: string): BossService {
  const filtered: Pick<BossService, 'send'> = {
    send: async (name, data, options) =>
      data['notificationQueueId'] === queueId ? realBoss.send(name, data, options) : null,
  }
  return filtered as BossService
}

async function pollUntilSent(orgId: string, id: string, capMs: number): Promise<number | null> {
  const started = Date.now()
  while (Date.now() - started < capMs) {
    const row = await readQueueRow(orgId, id)
    if (row && SENT_STATUSES.includes(row.status)) return Date.now() - started
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

beforeAll(async () => {
  await resetVaultForTest()
  await initVaultForTest(initVault, 'notification-originator-dispatch-delivery-secret')
})

afterAll(async () => {
  await resetVaultForTest()
})

beforeEach(() => {
  __resetNotificationDispatchBossForTests()
  __resetDeliveryProvidersForTests()
})

afterEach(() => {
  __resetNotificationDispatchBossForTests()
  __resetDeliveryProvidersForTests()
  resetEmailTransportForTesting()
})

describe('Story 70.2 AC3 — catch-up stays the fallback', () => {
  it('a failed dispatch is delivered exactly once by a later catch-up run', async () => {
    const { boss, send } = await startedMockBoss()
    send.mockRejectedValueOnce(new Error('pg-boss unavailable'))
    registerNotificationDispatchBoss(boss)
    const providerSend = vi.fn(async () => ({ providerMessageId: `pm-catchup-${randomUUID()}` }))
    registerEmailProvider(providerSend)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST)

    await withTestOrg(async ({ orgId }) => {
      const { notificationQueueId } = await bindAndRun(orgId, () =>
        host.enqueueNotification(emailParams('fallback'))
      )
      expect((await readQueueRow(orgId, notificationQueueId))?.status).toBe('pending')

      await backdateQueueRow(orgId, notificationQueueId)
      await runDeliverCatchup(boss, silentLogger)

      const jobs = sentJobsFor(send, notificationQueueId)
      // send call 1 was the rejected immediate dispatch; call 2 is the catch-up enqueue.
      expect(jobs).toHaveLength(2)
      await deliverNotification(notificationQueueId, orgId)

      expect(providerSend).toHaveBeenCalledTimes(1)
      expect(SENT_STATUSES).toContain((await readQueueRow(orgId, notificationQueueId))?.status)
    })
  })
})

describe('Story 70.2 AC4 — immediate dispatch plus catch-up never double-sends', () => {
  it('a delivered row is invisible to a later catch-up run', async () => {
    const { boss, send } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    const providerSend = vi.fn(async () => ({ providerMessageId: `pm-delivered-${randomUUID()}` }))
    registerEmailProvider(providerSend)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST)

    await withTestOrg(async ({ orgId }) => {
      const { notificationQueueId } = await bindAndRun(orgId, () =>
        host.enqueueNotification(emailParams('delivered'))
      )
      expect(sentJobsFor(send, notificationQueueId)).toHaveLength(1)
      await deliverNotification(notificationQueueId, orgId)
      expect(SENT_STATUSES).toContain((await readQueueRow(orgId, notificationQueueId))?.status)

      await backdateQueueRow(orgId, notificationQueueId)
      await runDeliverCatchup(boss, silentLogger)

      expect(sentJobsFor(send, notificationQueueId)).toHaveLength(1)
      expect(providerSend).toHaveBeenCalledTimes(1)
    })
  })

  it('an in-flight immediate job holds the lease: catch-up skips it and a second job sends nothing', async () => {
    const { boss, send } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    const gate = deferred()
    const entered = deferred()
    const providerSend = vi.fn(async () => {
      entered.resolve()
      await gate.promise
      return { providerMessageId: `pm-inflight-${randomUUID()}` }
    })
    registerEmailProvider(providerSend)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST)

    await withTestOrg(async ({ orgId }) => {
      const { notificationQueueId } = await bindAndRun(orgId, () =>
        host.enqueueNotification(emailParams('inflight'))
      )
      const firstJob = deliverNotification(notificationQueueId, orgId)
      await entered.promise

      await backdateQueueRow(orgId, notificationQueueId)
      await runDeliverCatchup(boss, silentLogger)
      expect(sentJobsFor(send, notificationQueueId)).toHaveLength(1)

      // Even if a second notification/deliver job for the same id does run, the claim refuses it.
      await deliverNotification(notificationQueueId, orgId)
      expect(providerSend).toHaveBeenCalledTimes(1)

      gate.resolve()
      await firstJob
      expect(providerSend).toHaveBeenCalledTimes(1)
      expect(SENT_STATUSES).toContain((await readQueueRow(orgId, notificationQueueId))?.status)
    })
  })

  it('a definitively failing immediate job releases the lease and is never sent twice successfully', async () => {
    const { boss } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    let successes = 0
    const providerSend = vi.fn(async () => {
      if (providerSend.mock.calls.length === 1) throw new Error('provider rejected')
      successes++
      return { providerMessageId: `pm-retry-${randomUUID()}` }
    })
    registerEmailProvider(providerSend)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST)

    await withTestOrg(async ({ orgId }) => {
      const { notificationQueueId } = await bindAndRun(orgId, () =>
        host.enqueueNotification(emailParams('fails'))
      )
      await deliverNotification(notificationQueueId, orgId).catch(() => undefined)
      await deliverNotification(notificationQueueId, orgId).catch(() => undefined)
      await deliverNotification(notificationQueueId, orgId).catch(() => undefined)

      expect(successes).toBe(1)
      expect(SENT_STATUSES).toContain((await readQueueRow(orgId, notificationQueueId))?.status)
    })
  })
})

describe('Story 70.2 AC6 — mismatched (id, orgId) pair', () => {
  it('a job naming the wrong org finds no row and sends nothing', async () => {
    const { boss } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    const providerSend = vi.fn(async () => ({ providerMessageId: `pm-never-${randomUUID()}` }))
    registerEmailProvider(providerSend)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST)

    await withTestOrg(async ({ orgId: orgA }) => {
      await withTestOrg(async ({ orgId: orgB }) => {
        const { notificationQueueId } = await host.enqueueNotificationForOrg({
          organizationId: orgB,
          ...emailParams('mismatch'),
        })

        await deliverNotification(notificationQueueId, orgA)

        expect(providerSend).not.toHaveBeenCalled()
        expect((await readQueueRow(orgB, notificationQueueId))?.status).toBe('pending')
      })
    })
  })
})

describe('Story 70.2 AC5 — first send in seconds, no catch-up tick (CM AC12 contract)', () => {
  let realBoss: BossService

  beforeAll(async () => {
    const connectionString = process.env['DATABASE_URL']
    if (!connectionString) throw new Error('DATABASE_URL is required for the real pg-boss test')
    realBoss = new BossService(connectionString)
    await realBoss.start()
    // Drop jobs left in the shared test queue by earlier runs so this suite's worker only sees
    // (and times) its own jobs.
    await getDb().execute(sql`DELETE FROM pgboss.job WHERE name = 'notification/deliver'`)
    await realBoss.registerWorker(
      'notification/deliver',
      wrapDeliverHandler(silentLogger, new EventEmitter()),
      { localConcurrency: 5 }
    )
  }, 60_000)

  afterAll(async () => {
    await realBoss.stop()
  }, 60_000)

  it('delivers within seconds of the enqueue returning, without runDeliverCatchup', async () => {
    registerNotificationDispatchBoss(realBoss)
    const providerSend = vi.fn(async () => ({ providerMessageId: `pm-latency-${randomUUID()}` }))
    registerEmailProvider(providerSend)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST)

    await withTestOrg(async ({ orgId }) => {
      const { notificationQueueId } = await bindAndRun(orgId, () =>
        host.enqueueNotification(emailParams('latency'))
      )

      const elapsedMs = await pollUntilSent(orgId, notificationQueueId, LATENCY_CAP_MS)

      process.stdout.write(`[70-2 AC5] first send after ${elapsedMs}ms (real pg-boss)\n`)
      expect(elapsedMs).not.toBeNull()
      expect(providerSend).toHaveBeenCalledTimes(1)
    })
  }, 60_000)

  it('negative control: with the registry empty nothing is delivered until catch-up runs', async () => {
    const providerSend = vi.fn(async () => ({ providerMessageId: `pm-control-${randomUUID()}` }))
    registerEmailProvider(providerSend)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST)

    await withTestOrg(async ({ orgId }) => {
      const { notificationQueueId } = await bindAndRun(orgId, () =>
        host.enqueueNotification(emailParams('control'))
      )

      expect(await pollUntilSent(orgId, notificationQueueId, NEGATIVE_CONTROL_MS)).toBeNull()
      expect(providerSend).not.toHaveBeenCalled()

      await backdateQueueRow(orgId, notificationQueueId)
      await runDeliverCatchup(onlyJobsFor(realBoss, notificationQueueId), silentLogger)

      const afterCatchup = await pollUntilSent(orgId, notificationQueueId, LATENCY_CAP_MS)
      expect(afterCatchup).not.toBeNull()
      expect(providerSend).toHaveBeenCalledTimes(1)
    })
  }, 90_000)
})
