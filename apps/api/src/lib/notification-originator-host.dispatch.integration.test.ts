import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { OperationalEvent } from '@project-vault/shared'
import { notificationQueue, orgMemberships } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import {
  NotificationOriginatorInvalidParamsError,
  NotificationOriginatorInvalidRecipientError,
  NotificationOriginatorRateLimitedError,
} from '@project-vault/extension-api'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  bindAndRun,
  DISPATCH_TEST_MANIFEST,
  readQueueRow,
  startedMockBoss,
} from '../__tests__/helpers/notification-originator-dispatch-helpers.js'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import {
  buildNotificationOriginatorHost,
  NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW,
} from './notification-originator-host.js'
import {
  __resetNotificationDispatchBossForTests,
  registerNotificationDispatchBoss,
} from './notification-dispatch-boss.js'

/**
 * Story 70.2 — post-commit, best-effort dispatch of `notification/deliver` from the originator
 * host (AC1, AC2, AC3, AC6, AC7, AC8, AC9), against the real test Postgres with a fake pg-boss
 * client behind a real `BossService`.
 */

configureAuthIntegrationEnv()

const { initVault } = await import('../modules/vault/key-service.js')

const SENTINEL_EMAIL = 'sentinel-recipient-70-2@example.com'
const SENTINEL_SUBJECT = 'SENTINEL-SUBJECT-70-2-xyzzy'
const SENTINEL_BODY = 'SENTINEL-BODY-70-2-plugh'
const DELIVER_JOB = 'notification/deliver'
const ORIGINATOR_LABEL = 'extension-notification-originator'
const AUDIT_EVENT = OperationalEvent.NOTIFICATION_ORIGINATOR_HOST_CALL_RECORDED

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() }
}

function emailParams(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'email' as const,
    recipientEmail: SENTINEL_EMAIL,
    subject: SENTINEL_SUBJECT,
    body: SENTINEL_BODY,
    ...overrides,
  }
}

function warnEvents(logger: ReturnType<typeof makeLogger>): string[] {
  return logger.warn.mock.calls.map(([payload]) => (payload as { eventType: string }).eventType)
}

function auditCalls(logger: ReturnType<typeof makeLogger>) {
  return logger.info.mock.calls.filter(
    ([payload]) => (payload as { eventType?: string }).eventType === AUDIT_EVENT
  )
}

beforeAll(async () => {
  await resetVaultForTest()
  await initVaultForTest(initVault, 'notification-originator-dispatch-vault-secret')
})

afterAll(async () => {
  await resetVaultForTest()
})

beforeEach(() => {
  __resetNotificationDispatchBossForTests()
})

afterEach(() => {
  __resetNotificationDispatchBossForTests()
})

describe('Story 70.2 AC1 — a committed enqueue sends notification/deliver', () => {
  it('in-request: sends exactly once, after commit, with ids only', async () => {
    const { boss, send } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, makeLogger())

    await withTestOrg(async ({ orgId }) => {
      let visibleAtSend: unknown
      send.mockImplementation(async (_name: string, data: { notificationQueueId: string }) => {
        // A separate withOrg connection can only see the row if the insert already committed.
        visibleAtSend = await readQueueRow(orgId, data.notificationQueueId)
        return 'job-id'
      })

      const result = await bindAndRun(orgId, () => host.enqueueNotification(emailParams()))

      expect(Object.keys(result)).toEqual(['notificationQueueId'])
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith(
        DELIVER_JOB,
        { notificationQueueId: result.notificationQueueId, orgId },
        expect.objectContaining({ retryLimit: 3, retryBackoff: true, retryDelay: 60 })
      )
      expect(visibleAtSend).toMatchObject({ id: result.notificationQueueId, status: 'pending' })
    })
  })

  it('out-of-request inbox: sends exactly once with the explicit org', async () => {
    const { boss, send } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, makeLogger())
    const userId = await createTestUser('dispatch-inbox-70-2')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values({ orgId, userId, role: 'member', status: 'active' })
        )

        const result = await host.enqueueNotificationForOrg({
          organizationId: orgId,
          channel: 'inbox',
          recipientUserId: userId,
          subject: SENTINEL_SUBJECT,
          body: SENTINEL_BODY,
        })

        expect(Object.keys(result)).toEqual(['notificationQueueId'])
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0]?.[0]).toBe(DELIVER_JOB)
        expect(send.mock.calls[0]?.[1]).toEqual({
          notificationQueueId: result.notificationQueueId,
          orgId,
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('never dispatches when no row was committed', async () => {
    const { boss, send } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, makeLogger(), {
      maxInFlight: 0,
    })

    await withTestOrg(async ({ orgId }) => {
      // validation failure (in-request)
      await expect(
        bindAndRun(orgId, () => host.enqueueNotification(emailParams({ subject: '' })))
      ).rejects.toBeInstanceOf(NotificationOriginatorInvalidParamsError)

      // rejected recipient (a user who is not a member of the org)
      const strangerId = await createTestUser('dispatch-stranger-70-2')
      try {
        await expect(
          bindAndRun(orgId, () =>
            host.enqueueNotification({
              channel: 'inbox',
              recipientUserId: strangerId,
              subject: SENTINEL_SUBJECT,
              body: SENTINEL_BODY,
            })
          )
        ).rejects.toBeInstanceOf(NotificationOriginatorInvalidRecipientError)
      } finally {
        await deleteTestUser(strangerId)
      }

      // out-of-request in-flight cap (maxInFlight 0 denies before any insert)
      await expect(
        host.enqueueNotificationForOrg({ organizationId: orgId, ...emailParams() })
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

      // rolling-window cap
      await withOrg(orgId, (tx) =>
        tx.insert(notificationQueue).values(
          Array.from({ length: NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW }, () => ({
            orgId,
            recipientEmail: SENTINEL_EMAIL,
            channel: 'email',
            templateId: `ext.${DISPATCH_TEST_MANIFEST.name}`,
            payload: { subject: 's', body: 'b' },
            status: 'pending' as const,
            originExtensionName: DISPATCH_TEST_MANIFEST.name,
            enqueuedOutOfRequest: false,
          }))
        )
      )
      const hostWithRoom = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, makeLogger())
      await expect(
        bindAndRun(orgId, () => hostWithRoom.enqueueNotification(emailParams()))
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

      expect(send).not.toHaveBeenCalled()
    })
  })
})

describe('Story 70.2 AC2 — the BossService is resolved lazily at call time', () => {
  it('a host built BEFORE registration still dispatches for a later enqueue', async () => {
    const logger = makeLogger()
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, logger)
    const { boss, send } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)

    await withTestOrg(async ({ orgId }) => {
      const result = await bindAndRun(orgId, () => host.enqueueNotification(emailParams()))
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[1]).toEqual({
        notificationQueueId: result.notificationQueueId,
        orgId,
      })
    })
  })

  it('an empty registry warns notification.dispatch.unavailable and the enqueue still succeeds', async () => {
    const logger = makeLogger()
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, logger)

    await withTestOrg(async ({ orgId }) => {
      const result = await bindAndRun(orgId, () => host.enqueueNotification(emailParams()))
      expect((await readQueueRow(orgId, result.notificationQueueId))?.status).toBe('pending')
    })

    expect(warnEvents(logger)).toEqual(['notification.dispatch.unavailable'])
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ label: ORIGINATOR_LABEL, jobCount: 1 })
  })

  it('a registered but not-started boss is treated as unavailable', async () => {
    const { boss, send } = createMockBoss()
    registerNotificationDispatchBoss(boss)
    const logger = makeLogger()
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, logger)

    await withTestOrg(async ({ orgId }) => {
      await bindAndRun(orgId, () => host.enqueueNotification(emailParams()))
    })

    expect(send).not.toHaveBeenCalled()
    expect(warnEvents(logger)).toEqual(['notification.dispatch.unavailable'])
  })
})

describe('Story 70.2 AC3/AC7/AC8 — dispatch is best-effort and leak-free', () => {
  it('a rejecting boss.send leaves the row pending, warns once, keeps the audit outcome ok', async () => {
    const { boss, send } = await startedMockBoss()
    send.mockRejectedValue(new Error('pg-boss exploded'))
    registerNotificationDispatchBoss(boss)
    const logger = makeLogger()
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, logger)

    await withTestOrg(async ({ orgId }) => {
      const result = await bindAndRun(orgId, () => host.enqueueNotification(emailParams()))

      const row = await readQueueRow(orgId, result.notificationQueueId)
      expect(row?.status).toBe('pending')
      expect(row?.attemptCount).toBe(0)
    })

    expect(warnEvents(logger)).toEqual(['notification.dispatch.failed'])
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ label: ORIGINATOR_LABEL, jobCount: 1 })
    const audits = auditCalls(logger)
    expect(audits).toHaveLength(1)
    expect(audits[0]?.[0]).toMatchObject({
      extensionName: DISPATCH_TEST_MANIFEST.name,
      channel: 'email',
      outcome: 'ok',
    })
    // AC8 — no recipient / subject / body in anything the dispatch logged.
    const serialized = JSON.stringify(logger.warn.mock.calls, (_key, value) =>
      value instanceof Error ? { message: value.message } : value
    )
    expect(serialized).not.toContain(SENTINEL_EMAIL)
    expect(serialized).not.toContain(SENTINEL_SUBJECT)
    expect(serialized).not.toContain(SENTINEL_BODY)
  })

  it('a throwing logger.warn never propagates', async () => {
    const { boss, send } = await startedMockBoss()
    send.mockRejectedValue(new Error('down'))
    registerNotificationDispatchBoss(boss)
    const logger = {
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('logger is broken')
      }),
    }
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, logger)

    await withTestOrg(async ({ orgId }) => {
      await expect(
        bindAndRun(orgId, () => host.enqueueNotification(emailParams()))
      ).resolves.toHaveProperty('notificationQueueId')
    })
  })

  it('the default empty logger never propagates', async () => {
    const { boss, send } = await startedMockBoss()
    send.mockRejectedValue(new Error('down'))
    registerNotificationDispatchBoss(boss)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST)

    await withTestOrg(async ({ orgId }) => {
      await expect(
        host.enqueueNotificationForOrg({ organizationId: orgId, ...emailParams() })
      ).resolves.toHaveProperty('notificationQueueId')
    })
  })

  it('emits exactly one audit record per successful call', async () => {
    const { boss } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    const logger = makeLogger()
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, logger)

    await withTestOrg(async ({ orgId }) => {
      await bindAndRun(orgId, () => host.enqueueNotification(emailParams()))
      await host.enqueueNotificationForOrg({ organizationId: orgId, ...emailParams() })
    })

    expect(auditCalls(logger)).toHaveLength(2)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('Story 70.2 AC6 — tenant isolation of the dispatched job', () => {
  it('carries the explicit org, never the ambient one', async () => {
    const { boss, send } = await startedMockBoss()
    registerNotificationDispatchBoss(boss)
    const host = buildNotificationOriginatorHost(DISPATCH_TEST_MANIFEST, makeLogger())

    await withTestOrg(async ({ orgId: orgA }) => {
      await withTestOrg(async ({ orgId: orgB }) => {
        const result = await bindAndRun(orgA, () =>
          host.enqueueNotificationForOrg({ organizationId: orgB, ...emailParams() })
        )

        expect(send.mock.calls[0]?.[1]).toEqual({
          notificationQueueId: result.notificationQueueId,
          orgId: orgB,
        })
        expect(await readQueueRow(orgA, result.notificationQueueId)).toBeUndefined()
        expect(await readQueueRow(orgB, result.notificationQueueId)).toBeDefined()
      })
    })
  })
})
