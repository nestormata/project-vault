import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import nodemailer from 'nodemailer'
import { withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships } from '@project-vault/db/schema'
import { createTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import {
  expectQueueStatus,
  getNotificationQueueEntry,
} from '../__tests__/helpers/notification-test-helpers.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  resetEmailTransportForTesting,
  sendEmailNotification,
  setEmailTransportForTesting,
} from './notification-email.js'

configureAuthIntegrationEnv()

// Story 20.11 AC4 — markNotificationDelivered()/markNotificationSuppressed() now delegate to
// applyDeliveryStatusUpdate(), which writes a same-transaction audit entry and needs a real
// (unsealed) vault for the audit HMAC key.
beforeAll(async () => {
  await resetVaultForTest()
  const { initVault } = await import('../modules/vault/key-service.js')
  await initVaultForTest(initVault, 'notification-email-vault-secret')
})

// Story 36.1 AC2/Task 4 — shared fixture identity for the extension-originated-row describe
// block below; a constant avoids sonarjs/no-duplicate-string tripping on these literals.
const EXT_MANIFEST_NAME = 'com.acme.notification-originator-fixture'
const EXT_TEMPLATE_ID = `ext.${EXT_MANIFEST_NAME}`

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
    templateId?: string
    payload?: Record<string, unknown>
    originExtensionName?: string | null
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
        templateId: values.templateId ?? 'security.failed_auth_threshold',
        payload: values.payload ?? TEMPLATE_PAYLOAD,
        status: values.status ?? 'pending',
        originExtensionName: values.originExtensionName ?? null,
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

  describe('Story 36.1 AC2/Task 4 — extension-originated rows bypass the closed template registry', () => {
    it('builds the outbound email directly from payload.subject/payload.body, HTML-escaped only in the HTML part, never through renderEmailTemplate', async () => {
      const transport = nodemailer.createTransport({ jsonTransport: true })
      const spy = vi.spyOn(transport, 'sendMail')
      setEmailTransportForTesting(transport)

      await withTestOrg(async ({ orgId }) => {
        const queueId = await seedEmailQueueEntry(orgId, {
          recipientUserId: null,
          recipientEmail: 'ext-recipient@example.com',
          templateId: EXT_TEMPLATE_ID,
          payload: { subject: 'Hello <b>there</b>', body: 'Body & "quoted" <script>x</script>' },
          originExtensionName: EXT_MANIFEST_NAME,
        })

        await sendEmailNotification(queueId, orgId)

        expect(spy).toHaveBeenCalledWith(
          expect.objectContaining({
            to: 'ext-recipient@example.com',
            subject: 'Hello <b>there</b>',
            text: 'Body & "quoted" <script>x</script>',
            html: '<p>Body &amp; &quot;quoted&quot; &lt;script&gt;x&lt;/script&gt;</p>',
          })
        )
        await expectQueueStatus(orgId, queueId, 'delivered')
      })
    })

    it('an extension-originated row with a reserved ext.<name> templateId is never routed through the generic JSON-dump fallback', async () => {
      const transport = nodemailer.createTransport({ jsonTransport: true })
      const spy = vi.spyOn(transport, 'sendMail')
      setEmailTransportForTesting(transport)

      await withTestOrg(async ({ orgId }) => {
        const queueId = await seedEmailQueueEntry(orgId, {
          recipientUserId: null,
          recipientEmail: 'ext-recipient-2@example.com',
          templateId: EXT_TEMPLATE_ID,
          payload: { subject: 'Subject', body: 'Body' },
          originExtensionName: EXT_MANIFEST_NAME,
        })

        await sendEmailNotification(queueId, orgId)

        const sent = spy.mock.calls[0]?.[0] as { subject?: string; text?: string } | undefined
        // The generic fallback's subject shape is `[Project Vault] Notification (<templateId>)`
        // and its text embeds a raw JSON.stringify(payload) dump — neither must appear here.
        expect(sent?.subject).not.toMatch(/\[Project Vault\] Notification/)
        expect(sent?.text).not.toContain('"subject"')
        expect(sent?.subject).toBe('Subject')
        expect(sent?.text).toBe('Body')
      })
    })

    it('log-injection-shaped content (embedded newlines) in payload.body is stored/sent as a plain string, never crashing or corrupting the send', async () => {
      const transport = nodemailer.createTransport({ jsonTransport: true })
      const spy = vi.spyOn(transport, 'sendMail')
      setEmailTransportForTesting(transport)
      const adversarialBody = 'line1\nline2 fake-log-line eventType=forged'

      await withTestOrg(async ({ orgId }) => {
        const queueId = await seedEmailQueueEntry(orgId, {
          recipientUserId: null,
          recipientEmail: 'ext-recipient-3@example.com',
          templateId: EXT_TEMPLATE_ID,
          payload: { subject: 'Subject', body: adversarialBody },
          originExtensionName: EXT_MANIFEST_NAME,
        })

        await expect(sendEmailNotification(queueId, orgId)).resolves.toBeUndefined()
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ text: adversarialBody }))
        await expectQueueStatus(orgId, queueId, 'delivered')
      })
    })
  })
})
