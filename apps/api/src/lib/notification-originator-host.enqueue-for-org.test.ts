import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  NotificationOriginatorInvalidParamsError,
  NotificationOriginatorInvalidRecipientError,
  NotificationOriginatorNoAmbientContextError,
  NotificationOriginatorRateLimitedError,
} from '@project-vault/extension-api'

/**
 * Story 58.1 — unit coverage for `enqueueNotificationForOrg`, mirroring
 * `monitoring-host.list-service-endpoints-for-scheduling.test.ts`'s own `withOrg`-mocking
 * precedent so this closure's own control flow (AC1 ambient-context independence, AC2 recipient
 * validation reuse, AC4 no-duplicated-insert-shape regression guard, AC5 out-of-request rate-limit
 * boundary, AC6 in-flight cap + audit logging) is isolated from a live database. Real-Postgres
 * cross-tenant proof (AC3) and dual-budget independence proof (AC5) live in
 * `notification-originator-host.integration.test.ts`.
 */

const { withOrg } = vi.hoisted(() => ({ withOrg: vi.fn() }))
vi.mock('@project-vault/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@project-vault/db')>()
  return { ...actual, withOrg }
})

const { resolveActiveOrgRole } = vi.hoisted(() => ({ resolveActiveOrgRole: vi.fn() }))
vi.mock('../plugins/authenticate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plugins/authenticate.js')>()
  return { ...actual, resolveActiveOrgRole }
})

const {
  buildNotificationOriginatorHost,
  NOTIFICATION_ORIGINATOR_HOST_MAX_IN_FLIGHT_PER_EXTENSION,
  __resetNotificationOriginatorHostInFlightForTests,
} = await import('./notification-originator-host.js')

// Test-fixture UUID, not a secret.
/* eslint-disable no-secrets/no-secrets */
const ORG_ID = '11111111-1111-1111-1111-111111111111'
/* eslint-enable no-secrets/no-secrets */

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.enqueue-for-org-fixture',
  apiVersion: '3.21.0',
  capabilities: [],
}

function makeFakeTx(opts: { rateLimitCount?: number; insertId?: string } = {}) {
  const rateLimitCount = opts.rateLimitCount ?? 0
  const insertId = opts.insertId ?? 'nq-1'
  const insertValues = vi.fn()
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ count: rateLimitCount }]),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        insertValues(values)
        return {
          returning: () => Promise.resolve([{ id: insertId }]),
        }
      },
    }),
    __insertValues: insertValues,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveActiveOrgRole.mockResolvedValue('member')
})

afterEach(() => {
  __resetNotificationOriginatorHostInFlightForTests()
  vi.restoreAllMocks()
})

describe('buildNotificationOriginatorHost.enqueueNotificationForOrg (Story 58.1)', () => {
  describe('AC1 — out-of-request-capable, never requires ambient context', () => {
    it('succeeds with zero ambient request context bound (no runWithRequestContext anywhere)', async () => {
      const tx = makeFakeTx()
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      const host = buildNotificationOriginatorHost(MANIFEST)

      const result = await host.enqueueNotificationForOrg({
        organizationId: ORG_ID,
        channel: 'email',
        recipientUserId: 'user-1',
        subject: 'Endpoint down',
        body: 'https://api.example.com has been unreachable for 3 consecutive checks.',
      })

      expect(result).toEqual({ notificationQueueId: 'nq-1' })
      expect(withOrg).toHaveBeenCalledWith(ORG_ID, expect.any(Function))
    })

    it('edge case: enqueueNotification (existing in-request method) still throws NotificationOriginatorNoAmbientContextError, unchanged', async () => {
      const host = buildNotificationOriginatorHost(MANIFEST)
      await expect(
        host.enqueueNotification({
          channel: 'email',
          recipientUserId: 'user-1',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorNoAmbientContextError)
    })

    it('rejects with NotificationOriginatorInvalidParamsError before any DB call on malformed params', async () => {
      const host = buildNotificationOriginatorHost(MANIFEST)
      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          subject: '',
          body: 'Body',
        } as never)
      ).rejects.toBeInstanceOf(NotificationOriginatorInvalidParamsError)
      expect(withOrg).not.toHaveBeenCalled()
    })
  })

  describe('AC2 — recipientUserId validated against the EXPLICIT organizationId', () => {
    it('happy path: an active member of organizationId succeeds', async () => {
      const tx = makeFakeTx()
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      resolveActiveOrgRole.mockResolvedValue('member')
      const host = buildNotificationOriginatorHost(MANIFEST)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'user-1',
          subject: 'Subject',
          body: 'Body',
        })
      ).resolves.toEqual({ notificationQueueId: 'nq-1' })
      expect(resolveActiveOrgRole).toHaveBeenCalledWith('user-1', ORG_ID)
    })

    it('edge case: a nonexistent recipientUserId rejects with NotificationOriginatorInvalidRecipientError', async () => {
      const tx = makeFakeTx()
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      resolveActiveOrgRole.mockResolvedValue(null)
      const host = buildNotificationOriginatorHost(MANIFEST)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'does-not-exist',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorInvalidRecipientError)
    })

    it('edge case: a member whose status is not active (mirrors a soft-deleted/deactivated membership row — resolveActiveOrgRole/activeMembershipRoleQuery already filters status = active) rejects with NotificationOriginatorInvalidRecipientError', async () => {
      const tx = makeFakeTx()
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      // resolveActiveOrgRole returns null for any row not matching status = 'active' — this
      // reuses the SAME query enqueueNotification's own recipient check already relies on, so a
      // deactivated/soft-deleted-equivalent row is structurally excluded here exactly as it is
      // there (confirmed against real source, Task 3 — org_memberships has no separate
      // soft-delete column; 'deactivated' status IS this codebase's soft-delete equivalent).
      resolveActiveOrgRole.mockResolvedValue(null)
      const host = buildNotificationOriginatorHost(MANIFEST)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'deactivated-user',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorInvalidRecipientError)
    })
  })

  describe('AC3 — scoped to the explicit organizationId, never ambient', () => {
    it('withOrg and the recipient check both use params.organizationId, not any ambient org', async () => {
      // Test-fixture UUID, not a secret.
      // eslint-disable-next-line no-secrets/no-secrets
      const otherOrgId = '22222222-2222-2222-2222-222222222222'
      const tx = makeFakeTx()
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      resolveActiveOrgRole.mockResolvedValue('member')
      const host = buildNotificationOriginatorHost(MANIFEST)

      await host.enqueueNotificationForOrg({
        organizationId: otherOrgId,
        channel: 'email',
        recipientUserId: 'user-1',
        subject: 'Subject',
        body: 'Body',
      })

      expect(withOrg).toHaveBeenCalledWith(otherOrgId, expect.any(Function))
      expect(resolveActiveOrgRole).toHaveBeenCalledWith('user-1', otherOrgId)
    })
  })

  describe('AC4 — no new duplicated delivery logic (structural regression guard)', () => {
    it('enqueueNotificationForOrg contains exactly one tx.insert(notificationQueue) call, same base column set as enqueueNotification plus enqueuedOutOfRequest', () => {
      const source = readFileSync(
        join(process.cwd(), 'src/lib/notification-originator-host.ts'),
        'utf-8'
      )

      const forOrgStart = source.indexOf('async enqueueNotificationForOrg(')
      expect(forOrgStart).toBeGreaterThan(-1)
      const forOrgSource = source.slice(forOrgStart)
      const insertMatches = forOrgSource.match(/tx\s*\.insert\(notificationQueue\)/g) ?? []
      expect(insertMatches).toHaveLength(1)

      const inRequestStart = source.indexOf('async enqueueNotification(')
      const inRequestEnd = forOrgStart
      const inRequestSource = source.slice(inRequestStart, inRequestEnd)
      const inRequestInsertMatches =
        inRequestSource.match(/tx\s*\.insert\(notificationQueue\)/g) ?? []
      expect(inRequestInsertMatches).toHaveLength(1)
    })

    it('the inserted row shape matches enqueueNotification exactly, plus enqueuedOutOfRequest: true', async () => {
      const tx = makeFakeTx()
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      resolveActiveOrgRole.mockResolvedValue('member')
      const host = buildNotificationOriginatorHost(MANIFEST)

      await host.enqueueNotificationForOrg({
        organizationId: ORG_ID,
        channel: 'email',
        recipientUserId: 'user-1',
        subject: 'Subject',
        body: 'Body',
      })

      expect(tx.__insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG_ID,
          recipientUserId: 'user-1',
          recipientEmail: null,
          channel: 'email',
          templateId: `ext.${MANIFEST.name}`,
          payload: { subject: 'Subject', body: 'Body' },
          status: 'pending',
          originExtensionName: MANIFEST.name,
          enqueuedOutOfRequest: true,
        })
      )
    })
  })

  describe('AC5 — independent out-of-request rolling-window rate-limit budget', () => {
    it('rejects with NotificationOriginatorRateLimitedError once the out-of-request COUNT reaches the cap', async () => {
      const tx = makeFakeTx({ rateLimitCount: 100 })
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      const host = buildNotificationOriginatorHost(MANIFEST)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'user-1',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)
    })

    it('succeeds at exactly one below the cap (boundary, not over it)', async () => {
      const tx = makeFakeTx({ rateLimitCount: 99 })
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      const host = buildNotificationOriginatorHost(MANIFEST)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'user-1',
          subject: 'Subject',
          body: 'Body',
        })
      ).resolves.toEqual({ notificationQueueId: 'nq-1' })
    })
  })

  describe('AC6 — in-flight cap (mirrors MONITORING_HOST_MAX_IN_FLIGHT_PER_EXTENSION) + audit logging on every outcome', () => {
    it('shares a per-extension in-flight budget and rate-limits after the cap, releasing the slot after each call', async () => {
      let releaseFirst: (() => void) | undefined
      withOrg.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ notificationQueueId: 'nq-1' })
          })
      )
      const host = buildNotificationOriginatorHost(MANIFEST, {}, { maxInFlight: 1 })

      const first = host.enqueueNotificationForOrg({
        organizationId: ORG_ID,
        channel: 'email',
        recipientUserId: 'user-1',
        subject: 'Subject',
        body: 'Body',
      })
      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'user-1',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

      releaseFirst?.()
      await expect(first).resolves.toEqual({ notificationQueueId: 'nq-1' })
    })

    it('default in-flight cap constant is exported and positive', () => {
      expect(NOTIFICATION_ORIGINATOR_HOST_MAX_IN_FLIGHT_PER_EXTENSION).toBeGreaterThan(0)
    })

    it('records an audit log entry with outcome "ok" on success', async () => {
      const tx = makeFakeTx()
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
      const host = buildNotificationOriginatorHost(MANIFEST, logger)

      await host.enqueueNotificationForOrg({
        organizationId: ORG_ID,
        channel: 'email',
        recipientUserId: 'user-1',
        subject: 'Subject',
        body: 'Body',
      })

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          extensionName: MANIFEST.name,
          channel: 'email',
          outcome: 'ok',
        }),
        expect.any(String)
      )
    })

    it('records an audit log entry with outcome "invalid-params-denied" before any DB call', async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
      const host = buildNotificationOriginatorHost(MANIFEST, logger)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          subject: '',
          body: 'Body',
        } as never)
      ).rejects.toBeInstanceOf(NotificationOriginatorInvalidParamsError)

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          extensionName: MANIFEST.name,
          outcome: 'invalid-params-denied',
        }),
        expect.any(String)
      )
    })

    it('records an audit log entry with outcome "invalid-recipient-denied"', async () => {
      const tx = makeFakeTx()
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      resolveActiveOrgRole.mockResolvedValue(null)
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
      const host = buildNotificationOriginatorHost(MANIFEST, logger)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'does-not-exist',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorInvalidRecipientError)

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          extensionName: MANIFEST.name,
          channel: 'email',
          outcome: 'invalid-recipient-denied',
        }),
        expect.any(String)
      )
    })

    it('records an audit log entry with outcome "rate-limited" when the out-of-request COUNT cap is reached, using the dedicated out-of-request warn event', async () => {
      const tx = makeFakeTx({ rateLimitCount: 100 })
      withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx))
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
      const host = buildNotificationOriginatorHost(MANIFEST, logger)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'user-1',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          extensionName: MANIFEST.name,
          outcome: 'rate-limited',
        }),
        expect.any(String)
      )
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'notification_originator_host.out_of_request_rate_limited',
        }),
        expect.any(String)
      )
    })

    it('records an audit log entry with outcome "error" when the insert fails unexpectedly', async () => {
      const dbError = new Error('boom')
      withOrg.mockRejectedValue(dbError)
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
      const host = buildNotificationOriginatorHost(MANIFEST, logger)

      await expect(
        host.enqueueNotificationForOrg({
          organizationId: ORG_ID,
          channel: 'email',
          recipientUserId: 'user-1',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBe(dbError)

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          extensionName: MANIFEST.name,
          outcome: 'error',
        }),
        expect.any(String)
      )
    })
  })
})
