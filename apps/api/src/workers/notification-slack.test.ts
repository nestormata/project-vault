import { afterEach, describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import {
  expectQueueStatus,
  getNotificationQueueEntry,
} from '../__tests__/helpers/notification-test-helpers.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

const FAILED_AUTH_TEMPLATE = 'security.failed_auth_threshold'
const SLACK_WEBHOOK_TEST_URL = 'https://hooks.slack.com/services/test'

async function seedSlackQueueEntry(orgId: string): Promise<string> {
  const [entry] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        recipientUserId: null,
        channel: 'slack',
        templateId: FAILED_AUTH_TEMPLATE,
        payload: { attemptCount: 1 },
        status: 'pending',
      })
      .returning({ id: notificationQueue.id })
  )
  if (!entry) throw new Error('expected queue entry')
  return entry.id
}

async function loadSendSlackNotification(webhookUrl?: string) {
  vi.resetModules()
  if (webhookUrl) {
    process.env['SLACK_WEBHOOK_URL'] = webhookUrl
  } else {
    delete process.env['SLACK_WEBHOOK_URL']
  }
  const mod = await import('./notification-slack.js')
  return mod.sendSlackNotification
}

async function runSlackScenario(
  orgId: string,
  sendSlackNotification: (id: string, orgId: string) => Promise<void>,
  assertion: (queueId: string) => Promise<void>
) {
  const queueId = await seedSlackQueueEntry(orgId)
  await sendSlackNotification(queueId, orgId)
  await assertion(queueId)
}

describe('sendSlackNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env['SLACK_WEBHOOK_URL']
  })

  it('sends Slack message and marks entry delivered on 2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
    )
    const sendSlackNotification = await loadSendSlackNotification(SLACK_WEBHOOK_TEST_URL)

    await withTestOrg(async ({ orgId }) => {
      await runSlackScenario(orgId, sendSlackNotification, async (queueId) => {
        await expectQueueStatus(orgId, queueId, 'delivered')
      })
    })
  })

  it('throws on non-2xx Slack response (pg-boss retries)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' })
    )
    const sendSlackNotification = await loadSendSlackNotification(SLACK_WEBHOOK_TEST_URL)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedSlackQueueEntry(orgId)
      await expect(sendSlackNotification(queueId, orgId)).rejects.toThrow('429')
      const updated = await getNotificationQueueEntry(orgId, queueId)
      expect(updated?.status).toBe('pending')
      expect(updated?.attemptCount).toBe(1)
    })
  })

  it('marks entry suppressed when SLACK_WEBHOOK_URL is not configured', async () => {
    const sendSlackNotification = await loadSendSlackNotification()

    await withTestOrg(async ({ orgId }) => {
      await runSlackScenario(orgId, sendSlackNotification, async (queueId) => {
        await expectQueueStatus(orgId, queueId, 'suppressed')
      })
    })
  })

  it('throws on network error (fetch rejected)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const sendSlackNotification = await loadSendSlackNotification(SLACK_WEBHOOK_TEST_URL)

    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedSlackQueueEntry(orgId)
      await expect(sendSlackNotification(queueId, orgId)).rejects.toThrow('ECONNREFUSED')
      const updated = await getNotificationQueueEntry(orgId, queueId)
      expect(updated?.attemptCount).toBe(1)
    })
  })
})
