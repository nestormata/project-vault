import { describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships } from '@project-vault/db/schema'
import {
  NOTIFICATION_ALERT_TYPES,
  DEFAULT_NOTIFICATION_MIN_SEVERITY,
  DEFAULT_NOTIFICATION_FREQUENCY,
} from '@project-vault/shared'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { createOrgAdminNotificationEntries, sendNotificationJobs } from './dispatcher.js'
import { patchPreferences } from '../modules/notifications/preferences.js'
import { putOrgRouting } from '../modules/notifications/routing.js'

const FAILED_AUTH_TEMPLATE = 'security.failed_auth_threshold'
const SERVICE_DOWN_TEMPLATE = 'service.down'

async function seedOwner(orgId: string, userId: string) {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role: 'owner', status: 'active' })
  )
}

describe('notification dispatcher', () => {
  it('creates email and inbox entries for owner with default preferences', async () => {
    const userId = await createTestUser('dispatcher-owner')
    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, userId)

        const jobs = await withOrg(orgId, (tx) =>
          createOrgAdminNotificationEntries({
            orgId,
            template: {
              templateId: FAILED_AUTH_TEMPLATE,
              payload: { attemptCount: 1 },
              severity: 'warning',
            },
            tx,
          })
        )

        expect(jobs.length).toBeGreaterThanOrEqual(2)

        const rows = await withOrg(orgId, (tx) => tx.select().from(notificationQueue))
        expect(rows.some((row) => row.channel === 'email')).toBe(true)
        expect(rows.some((row) => row.channel === 'inbox')).toBe(true)
        expect(rows.some((row) => row.channel === 'slack')).toBe(false)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('sends notification:deliver jobs for immediate entries', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()

    await sendNotificationJobs(boss, [
      { id: crypto.randomUUID(), orgId: crypto.randomUUID(), deliverAt: null },
    ])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBe('notification:deliver')
  })

  it('does not send jobs for digest-scheduled entries', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()

    await sendNotificationJobs(boss, [
      {
        id: crypto.randomUUID(),
        orgId: crypto.randomUUID(),
        deliverAt: new Date(Date.now() + 60_000),
      },
    ])

    expect(send).not.toHaveBeenCalled()
  })

  it('severity filtering skips email when alert severity is below user threshold', async () => {
    const userId = await createTestUser('dispatcher-severity')
    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, userId)
        await withOrg(orgId, (tx) =>
          patchPreferences(
            orgId,
            userId,
            [
              {
                alertType: FAILED_AUTH_TEMPLATE,
                channel: 'email',
                frequency: 'immediate',
                minSeverity: 'critical',
              },
            ],
            tx
          )
        )

        const { boss, send } = createMockBoss()
        const jobs = await withOrg(orgId, (tx) =>
          createOrgAdminNotificationEntries({
            orgId,
            template: {
              templateId: FAILED_AUTH_TEMPLATE,
              payload: {},
              severity: 'warning',
            },
            tx,
          })
        )
        await sendNotificationJobs(boss, jobs)

        const rows = await withOrg(orgId, (tx) => tx.select().from(notificationQueue))
        expect(rows.filter((r) => r.channel === 'email')).toHaveLength(0)
        expect(send).not.toHaveBeenCalled()
        void jobs
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('sets deliverAt for digest_daily email preference', async () => {
    const userId = await createTestUser('dispatcher-digest')
    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, userId)
        await withOrg(orgId, (tx) =>
          patchPreferences(
            orgId,
            userId,
            [
              {
                alertType: FAILED_AUTH_TEMPLATE,
                channel: 'email',
                frequency: 'digest_daily',
                minSeverity: 'warning',
              },
            ],
            tx
          )
        )

        const jobs = await withOrg(orgId, (tx) =>
          createOrgAdminNotificationEntries({
            orgId,
            template: {
              templateId: FAILED_AUTH_TEMPLATE,
              payload: {},
              severity: 'warning',
            },
            tx,
          })
        )

        const emailRow = await withOrg(orgId, async (tx) => {
          const rows = await tx.select().from(notificationQueue)
          return rows.find((r) => r.channel === 'email')
        })
        expect(emailRow?.deliverAt).not.toBeNull()
        expect(jobs.every((j) => j.deliverAt === null || j.deliverAt.getTime() > Date.now())).toBe(
          true
        )
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('falls back to owner when routing target role has zero members', async () => {
    const ownerId = await createTestUser('dispatcher-fallback-owner')
    try {
      await withTestOrg(async ({ orgId }) => {
        await seedOwner(orgId, ownerId)
        await withOrg(orgId, (tx) =>
          putOrgRouting(orgId, [{ alertType: SERVICE_DOWN_TEMPLATE, routeTo: 'admin' }], tx)
        )

        const logSpy = vi.spyOn(process.stdout, 'write')
        const jobs = await withOrg(orgId, (tx) =>
          createOrgAdminNotificationEntries({
            orgId,
            template: { templateId: SERVICE_DOWN_TEMPLATE, payload: {}, severity: 'warning' },
            tx,
          })
        )

        expect(jobs.length).toBeGreaterThan(0)
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining('notification.routing_fallback')
        )
        logSpy.mockRestore()
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })
})

describe('notification preferences defaults', () => {
  it('exposes defaults for all alert types when no rows stored', async () => {
    const userId = await createTestUser('prefs-defaults')
    try {
      await withTestOrg(async ({ orgId }) => {
        const { getPreferences } = await import('../modules/notifications/preferences.js')
        const prefs = await withOrg(orgId, (tx) => getPreferences(orgId, userId, tx))
        const emailPrefs = prefs.filter((p) => p.channel === 'email')
        const inboxPrefs = prefs.filter((p) => p.channel === 'inbox')
        expect(emailPrefs.length).toBe(NOTIFICATION_ALERT_TYPES.length)
        expect(inboxPrefs.length).toBe(NOTIFICATION_ALERT_TYPES.length)
        expect(prefs.every((p) => p.frequency === DEFAULT_NOTIFICATION_FREQUENCY)).toBe(true)
        expect(prefs.every((p) => p.minSeverity === DEFAULT_NOTIFICATION_MIN_SEVERITY)).toBe(true)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
