import { afterEach, describe, expect, it, vi } from 'vitest'
import nodemailer from 'nodemailer'
import { withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships } from '@project-vault/db/schema'
import { createTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import {
  expectQueueStatus,
  getNotificationQueueEntry,
} from '../__tests__/helpers/notification-test-helpers.js'
import {
  resetEmailTransportForTesting,
  sendEmailNotification,
  setEmailTransportForTesting,
} from './notification-email.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

const TEMPLATE_PAYLOAD = {
  thresholdType: 'ip',
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 10,
  windowStart: new Date().toISOString(),
  windowEnd: new Date().toISOString(),
  ipAddress: '203.0.113.1',
}

async function seedEmailQueueEntry(
  orgId: string,
  values: {
    recipientUserId?: string | null
    recipientEmail?: string | null
    status?: 'pending' | 'delivered' | 'failed' | 'suppressed'
  }
): Promise<string> {
  const [entry] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        recipientUserId: values.recipientUserId ?? null,
        recipientEmail: values.recipientEmail ?? null,
        channel: 'email',
        templateId: 'security.failed_auth_threshold',
        payload: TEMPLATE_PAYLOAD,
        status: values.status ?? 'pending',
      })
      .returning({ id: notificationQueue.id })
  )
  if (!entry) throw new Error('expected queue entry')
  return entry.id
}

async function withOwnerMembership(orgId: string, userId: string) {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({
      orgId,
      userId,
      role: 'owner',
      status: 'active',
    })
  )
}

describe('sendEmailNotification', () => {
  afterEach(() => {
    resetEmailTransportForTesting()
  })

  it('sends email and marks queue entry delivered on success', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    setEmailTransportForTesting(transport)
    const userId = await createTestUser('notification-email-success')

    await withTestOrg(async ({ orgId }) => {
      await withOwnerMembership(orgId, userId)
      const queueId = await seedEmailQueueEntry(orgId, { recipientUserId: userId })

      await sendEmailNotification(queueId, orgId)

      const updated = await expectQueueStatus(orgId, queueId, 'delivered')
      expect(updated?.deliveredAt).not.toBeNull()
      expect(updated?.attemptCount).toBe(1)
    })
  })

  it('marks entry suppressed when SMTP is not configured', async () => {
    setEmailTransportForTesting(null)
    const userId = await createTestUser('notification-email-suppressed')

    await withTestOrg(async ({ orgId }) => {
      await withOwnerMembership(orgId, userId)
      const queueId = await seedEmailQueueEntry(orgId, { recipientUserId: userId })

      await sendEmailNotification(queueId, orgId)
      await expectQueueStatus(orgId, queueId, 'suppressed')
    })
  })

  it('delivers to recipientEmail when there is no recipientUserId (Story 4.1 invitations, AC-7)', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const spy = vi.spyOn(transport, 'sendMail')
    setEmailTransportForTesting(transport)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailQueueEntry(orgId, {
        recipientUserId: null,
        recipientEmail: 'jordan@example.com',
      })

      await sendEmailNotification(queueId, orgId)

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ to: 'jordan@example.com' }))
      await expectQueueStatus(orgId, queueId, 'delivered')
    })
  })

  it('marks entry suppressed when recipient email cannot be resolved', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    setEmailTransportForTesting(transport)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedEmailQueueEntry(orgId, { recipientUserId: null })

      await sendEmailNotification(queueId, orgId)
      await expectQueueStatus(orgId, queueId, 'suppressed')
    })
  })

  it('throws and increments attemptCount on SMTP failure (pg-boss will retry)', async () => {
    const failingTransport = nodemailer.createTransport({ streamTransport: true })
    vi.spyOn(failingTransport, 'sendMail').mockRejectedValue(new Error('ECONNREFUSED'))
    setEmailTransportForTesting(failingTransport)
    const userId = await createTestUser('notification-email-fail')

    await withTestOrg(async ({ orgId }) => {
      await withOwnerMembership(orgId, userId)
      const queueId = await seedEmailQueueEntry(orgId, { recipientUserId: userId })

      await expect(sendEmailNotification(queueId, orgId)).rejects.toThrow('ECONNREFUSED')

      const updated = await getNotificationQueueEntry(orgId, queueId)
      expect(updated?.status).toBe('pending')
      expect(updated?.attemptCount).toBe(1)
    })
  })

  it('is idempotent — skips already-delivered entries', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    setEmailTransportForTesting(transport)
    const spy = vi.spyOn(transport, 'sendMail')
    const userId = await createTestUser('notification-email-idempotent')

    await withTestOrg(async ({ orgId }) => {
      await withOwnerMembership(orgId, userId)
      const queueId = await seedEmailQueueEntry(orgId, {
        recipientUserId: userId,
        status: 'delivered',
      })

      await sendEmailNotification(queueId, orgId)
      expect(spy).not.toHaveBeenCalled()
    })
  })
})
