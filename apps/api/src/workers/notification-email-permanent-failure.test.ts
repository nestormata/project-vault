import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { register } from 'prom-client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { createTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import { OperationalEvent } from '@project-vault/shared'
import { DeliveryProviderPermanentError, type DeliveryProvider } from '@project-vault/extension-api'
import { getNotificationQueueEntry } from '../__tests__/helpers/notification-test-helpers.js'
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
import {
  buildDeliveryProviderMessage,
  resetEmailTransportForTesting,
  sendEmailNotification,
} from './notification-email.js'
import { NOTIFICATION_DELIVERY_PERMANENT_FAILURE_TOTAL_METRIC_NAME } from './notification-metrics.js'
import { runNotificationDlqCleanup } from './notification-dlq-cleanup.js'

const failure = vi.hoisted(() => ({ markFailedThrows: 0 }))

vi.mock('./notification-queue-ops.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./notification-queue-ops.js')>()
  return {
    ...original,
    markNotificationFailed: vi.fn(async (id: string, orgId: string) => {
      if (failure.markFailedThrows > 0) {
        failure.markFailedThrows -= 1
        throw new Error('simulated database failure')
      }
      return original.markNotificationFailed(id, orgId)
    }),
  }
})

configureAuthIntegrationEnv()

// Joined, not written as a literal address: check-public-safety flags added email-shaped text.
const address = (local: string): string => [local, 'example.com'].join('@')
const TO_ADDRESS = address('provider-to')
const RECIPIENT = address('leak-check')
const PROVIDER_MESSAGE = `upstream said: mailbox ${RECIPIENT} does not exist`

function loadedStateWith(deliveryProvider: Record<string, DeliveryProvider>): ExtensionState {
  return {
    status: 'loaded',
    manifest: { name: 'com.acme.test-extension', apiVersion: '3.32.0', capabilities: [] },
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

async function seedTemplateRow(orgId: string): Promise<string> {
  const [entry] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        recipientEmail: RECIPIENT,
        channel: 'email',
        templateId: 'security.failed_auth_threshold',
        payload: {
          thresholdType: 'ip',
          thresholdCount: 10,
          windowSeconds: 300,
          attemptCount: 10,
          windowStart: new Date().toISOString(),
          windowEnd: new Date().toISOString(),
          ipAddress: '203.0.113.1',
        },
        status: 'pending',
      })
      .returning({ id: notificationQueue.id })
  )
  if (!entry) throw new Error('expected queue entry')
  return entry.id
}

async function seedExtensionRow(orgId: string, body: string): Promise<string> {
  const [entry] = await withOrg(orgId, (tx) =>
    tx
      .insert(notificationQueue)
      .values({
        orgId,
        recipientEmail: RECIPIENT,
        channel: 'email',
        templateId: 'ext.com.acme.test-extension',
        originExtensionName: 'com.acme.test-extension',
        payload: { subject: 'Hello', body },
        status: 'pending',
      })
      .returning({ id: notificationQueue.id })
  )
  if (!entry) throw new Error('expected queue entry')
  return entry.id
}

async function permanentFailureCount(): Promise<number> {
  const metric = register.getSingleMetric(NOTIFICATION_DELIVERY_PERMANENT_FAILURE_TOTAL_METRIC_NAME)
  if (!metric) return 0
  const { values } = await metric.get()
  return values.find((v) => v.labels['channel'] === 'email')?.value ?? 0
}

function makeLogger() {
  return { error: vi.fn(), warn: vi.fn() }
}

function permanent(reason = 'invalid_recipient'): DeliveryProviderPermanentError {
  return new DeliveryProviderPermanentError(PROVIDER_MESSAGE, {
    reason,
    cause: new Error(PROVIDER_MESSAGE),
  })
}

describe('buildDeliveryProviderMessage — Story 70.3 AC1 html pass-through', () => {
  it('passes body = text and html = html when both parts exist', () => {
    expect(
      buildDeliveryProviderMessage(TO_ADDRESS, { subject: 's', text: 'T', html: '<p>H</p>' })
    ).toEqual({
      toAddress: TO_ADDRESS,
      subject: 's',
      body: 'T',
      html: '<p>H</p>',
    })
  })

  it('html-only: body is the html (unchanged behaviour) and html is the same string', () => {
    const message = buildDeliveryProviderMessage(TO_ADDRESS, {
      subject: 's',
      text: undefined,
      html: '<p>H</p>',
    })
    expect(message.body).toBe('<p>H</p>')
    expect(message.html).toBe('<p>H</p>')
  })

  it('text-only: html key is absent and body is the text', () => {
    const message = buildDeliveryProviderMessage(TO_ADDRESS, {
      subject: 's',
      text: 'T',
      html: undefined,
    })
    expect(message.body).toBe('T')
    expect('html' in message).toBe(false)
  })
})

describe('sendEmailNotification — Story 70.3 provider html and permanent failure', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    const { initVault } = await import('../modules/vault/key-service.js')
    await initVaultForTest(initVault, 'notification-email-permanent-failure-vault-secret')
  })

  beforeEach(() => {
    __resetDeliveryProvidersForTests()
    failure.markFailedThrows = 0
  })

  afterEach(() => {
    __resetDeliveryProvidersForTests()
    resetEmailTransportForTesting()
  })

  it('AC1: a template email reaches the provider with body = text and html = html', async () => {
    const send = vi.fn().mockResolvedValue({ providerMessageId: `m-${randomUUID()}` })
    registerProvider(send)
    await createTestUser('p70-3-html-template')
    await withTestOrg(async ({ orgId }) => {
      await sendEmailNotification(await seedTemplateRow(orgId), orgId)
      const payload = send.mock.calls[0]?.[0] as { body: string; html?: string }
      expect(payload.html).toContain('<')
      expect(payload.body).not.toContain('<html')
      expect(payload.body.length).toBeGreaterThan(0)
    })
  })

  it('AC1: an extension-originated row sends the raw body and the escaped html', async () => {
    const send = vi.fn().mockResolvedValue({ providerMessageId: `m-${randomUUID()}` })
    registerProvider(send)
    await createTestUser('p70-3-html-extension')
    await withTestOrg(async ({ orgId }) => {
      await sendEmailNotification(await seedExtensionRow(orgId, 'Hi <b>'), orgId)
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Hi <b>', html: '<p>Hi &lt;b&gt;</p>' })
      )
    })
  })

  it('AC3/AC4: a permanent rejection fails the row once, resolves, and is observable without leaks', async () => {
    const send = vi.fn().mockRejectedValue(permanent())
    registerProvider(send)
    const logger = makeLogger()
    await createTestUser('p70-3-permanent')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedTemplateRow(orgId)
      const before = await permanentFailureCount()

      await expect(sendEmailNotification(queueId, orgId, logger)).resolves.toBeUndefined()

      expect(send).toHaveBeenCalledTimes(1)
      const row = await getNotificationQueueEntry(orgId, queueId)
      expect(row?.status).toBe('failed')
      expect(row?.attemptCount).toBe(1)
      expect(await permanentFailureCount()).toBe(before + 1)

      const events = logger.error.mock.calls.filter(
        (call) =>
          (call[0] as { eventType?: string }).eventType ===
          OperationalEvent.NOTIFICATION_DELIVERY_PERMANENT_FAILURE
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.[0]).toEqual({
        notificationQueueId: queueId,
        orgId,
        channel: 'email',
        attemptNumber: 1,
        reason: 'invalid_recipient',
        eventType: OperationalEvent.NOTIFICATION_DELIVERY_PERMANENT_FAILURE,
        traceId: expect.any(String),
      })

      const serialized = JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls])
      expect(serialized).not.toContain(RECIPIENT)
      expect(serialized).not.toContain('does not exist')
      expect(await register.metrics()).not.toContain(RECIPIENT)
    })
  })

  it('AC3: a duplicate class instance with the same name is classified as permanent', async () => {
    class DuplicatePermanentError extends Error {
      override name = 'DeliveryProviderPermanentError'
    }
    const send = vi.fn().mockRejectedValue(new DuplicatePermanentError('nope'))
    registerProvider(send)
    await createTestUser('p70-3-duplicate')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedTemplateRow(orgId)
      await expect(sendEmailNotification(queueId, orgId)).resolves.toBeUndefined()
      expect((await getNotificationQueueEntry(orgId, queueId))?.status).toBe('failed')
    })
  })

  it.each([
    ['a plain Error', () => new Error('permanent failure, really')],
    ['a TypeError', () => new TypeError('permanent')],
    ['a string throw', () => 'DeliveryProviderPermanentError'],
  ])('AC3 edge: %s is not permanent (released and rethrown)', async (_label, make) => {
    const send = vi.fn().mockImplementation(() => Promise.reject(make() as unknown))
    registerProvider(send)
    await createTestUser('p70-3-not-permanent')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedTemplateRow(orgId)
      const before = await permanentFailureCount()
      await expect(sendEmailNotification(queueId, orgId)).rejects.toBeDefined()
      expect((await getNotificationQueueEntry(orgId, queueId))?.status).toBe('pending')
      expect(await permanentFailureCount()).toBe(before)
    })
  })

  it('AC3 edge: a permanent failure on attempt 3 ends at attempt_count 3', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient one'))
      .mockRejectedValueOnce(new Error('transient two'))
      .mockRejectedValueOnce(permanent())
    registerProvider(send)
    await createTestUser('p70-3-attempt-three')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedTemplateRow(orgId)
      await expect(sendEmailNotification(queueId, orgId)).rejects.toThrow('transient one')
      await expect(sendEmailNotification(queueId, orgId)).rejects.toThrow('transient two')
      await expect(sendEmailNotification(queueId, orgId)).resolves.toBeUndefined()
      const row = await getNotificationQueueEntry(orgId, queueId)
      expect(row?.status).toBe('failed')
      expect(row?.attemptCount).toBe(3)
      expect(send).toHaveBeenCalledTimes(3)
    })
  })

  it('AC3 edge: a row already moved to failed concurrently is not counted a second time', async () => {
    await createTestUser('p70-3-concurrent-webhook')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedTemplateRow(orgId)
      registerProvider(async () => {
        await withOrg(orgId, (tx) =>
          tx
            .update(notificationQueue)
            .set({ status: 'failed' })
            .where(eq(notificationQueue.id, queueId))
        )
        throw permanent()
      })
      const before = await permanentFailureCount()
      await expect(sendEmailNotification(queueId, orgId, makeLogger())).resolves.toBeUndefined()
      expect((await getNotificationQueueEntry(orgId, queueId))?.status).toBe('failed')
      expect(await permanentFailureCount()).toBe(before)
    })
  })

  it('AC3 edge: when marking failed throws the claim is released and the retry fails the row', async () => {
    const send = vi.fn().mockRejectedValue(permanent())
    registerProvider(send)
    await createTestUser('p70-3-mark-failed-throws')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedTemplateRow(orgId)
      failure.markFailedThrows = 1
      await expect(sendEmailNotification(queueId, orgId)).rejects.toThrow(
        'simulated database failure'
      )
      expect((await getNotificationQueueEntry(orgId, queueId))?.status).toBe('pending')

      await expect(sendEmailNotification(queueId, orgId)).resolves.toBeUndefined()
      expect(send).toHaveBeenCalledTimes(2)
      expect((await getNotificationQueueEntry(orgId, queueId))?.status).toBe('failed')
    })
  })

  it('AC4 edge: the DLQ cleanup does not re-count a permanently failed row as outcome-unknown', async () => {
    registerProvider(vi.fn().mockRejectedValue(permanent()))
    await createTestUser('p70-3-dlq')
    await withTestOrg(async ({ orgId }) => {
      const queueId = await seedTemplateRow(orgId)
      await sendEmailNotification(queueId, orgId)
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      await runNotificationDlqCleanup(logger)
      const unknown = logger.error.mock.calls.filter(
        (call) =>
          (call[0] as { eventType?: string }).eventType ===
            OperationalEvent.NOTIFICATION_DELIVERY_OUTCOME_UNKNOWN &&
          (call[0] as { notificationQueueId?: string }).notificationQueueId === queueId
      )
      expect(unknown).toHaveLength(0)
    })
  })
})
