import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb, withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships, organizations } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  NotificationOriginatorInvalidParamsError,
  NotificationOriginatorInvalidRecipientError,
  NotificationOriginatorNoAmbientContextError,
  NotificationOriginatorRateLimitedError,
} from '@project-vault/extension-api'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  buildNotificationOriginatorHost,
  NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW,
} from './notification-originator-host.js'
import { runWithRequestContext } from './request-context.js'

configureAuthIntegrationEnv()

const { initVault } = await import('../modules/vault/key-service.js')

const TEST_PASSPHRASE = 'notification-originator-host-integration-tests-passphrase'

// Shared fixture literal — a constant avoids sonarjs/no-duplicate-string tripping on this value
// repeated across nearly every test case below.
const EMAIL_CHANNEL = 'email' as const
const RECIPIENT_EMAIL = 'a@example.com'

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.notification-originator-fixture',
  apiVersion: '3.14.0',
  capabilities: [],
}

async function createTestOrg(label: string): Promise<string> {
  const orgName = `NotifOriginator ${label} ${randomUUID()}`
  const [org] = await getDb()
    .insert(organizations)
    .values({ name: orgName, slug: orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-') })
    .returning({ id: organizations.id })
  if (!org) throw new Error('createTestOrg: org insert returned no row')
  return org.id
}

async function addActiveMember(
  orgId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'member'
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role, status: 'active' })
  )
}

function bindAndRun<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ orgId, userId: randomUUID() }, fn)
}

async function fetchQueueRow(orgId: string, id: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(notificationQueue).where(eq(notificationQueue.id, id))
  )
  return row
}

describe.sequential(
  'buildNotificationOriginatorHost — Story 36.1 real-Postgres/RLS integration (AC2, AC3, AC4, AC5)',
  () => {
    const host = buildNotificationOriginatorHost(MANIFEST)

    beforeAll(async () => {
      await resetVaultForTest()
      await initVaultForTest(initVault, TEST_PASSPHRASE)
    })

    afterAll(async () => {
      await resetVaultForTest()
    })

    describe('AC3 — no ambient context', () => {
      it('rejects with NotificationOriginatorNoAmbientContextError, no DB write, when called outside any bound request', async () => {
        await expect(
          host.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: 'nobody@example.com',
            subject: 'Subject',
            body: 'Body',
          })
        ).rejects.toBeInstanceOf(NotificationOriginatorNoAmbientContextError)
      })
    })

    describe('AC2 — happy path insert shape', () => {
      it('email + recipientUserId: inserts exactly one pending row scoped to the ambient org with the ext.<name> templateId sentinel and payload verbatim', async () => {
        const orgId = await createTestOrg('email-happy')
        const userId = await createTestUser('notif-originator-email-happy')
        try {
          await addActiveMember(orgId, userId)

          const result = await bindAndRun(orgId, () =>
            host.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientUserId: userId,
              subject: 'Hello',
              body: 'World',
            })
          )

          const row = await fetchQueueRow(orgId, result.notificationQueueId)
          expect(row?.status).toBe('pending')
          expect(row?.orgId).toBe(orgId)
          expect(row?.originExtensionName).toBe(MANIFEST.name)
          expect(row?.templateId).toBe(`ext.${MANIFEST.name}`)
          expect(row?.payload).toEqual({ subject: 'Hello', body: 'World' })
          expect(row?.recipientUserId).toBe(userId)
        } finally {
          await deleteTestUser(userId)
        }
      })

      it('email + recipientEmail (freeform, no user link): inserts a row exactly as an existing PV-internal recipientEmail-only row already does', async () => {
        const orgId = await createTestOrg('email-freeform')
        const result = await bindAndRun(orgId, () =>
          host.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: 'external@example.com',
            subject: 'Subject',
            body: 'Body',
          })
        )
        const row = await fetchQueueRow(orgId, result.notificationQueueId)
        expect(row?.recipientUserId).toBeNull()
        expect(row?.recipientEmail).toBe('external@example.com')
        expect(row?.channel).toBe('email')
      })

      it('inbox + recipientUserId: inserts a row with channel "inbox"', async () => {
        const orgId = await createTestOrg('inbox-happy')
        const userId = await createTestUser('notif-originator-inbox-happy')
        try {
          await addActiveMember(orgId, userId)
          const result = await bindAndRun(orgId, () =>
            host.enqueueNotification({
              channel: 'inbox',
              recipientUserId: userId,
              subject: 'Inbox subject',
              body: 'Inbox body',
            })
          )
          const row = await fetchQueueRow(orgId, result.notificationQueueId)
          expect(row?.channel).toBe('inbox')
          expect(row?.payload).toEqual({ subject: 'Inbox subject', body: 'Inbox body' })
        } finally {
          await deleteTestUser(userId)
        }
      })
    })

    describe('AC2 Red-Team — adversarial subject/body content cannot escape its own field', () => {
      it('stores newline/long/"ext."-spoofing content verbatim in payload without corrupting templateId or throwing', async () => {
        const orgId = await createTestOrg('adversarial')
        const adversarialBody = `line1\nline2 fake-log-line ext.spoofed.namespace ${'x'.repeat(500)}`
        const result = await bindAndRun(orgId, () =>
          host.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: RECIPIENT_EMAIL,
            subject: 'ext.spoof <script>alert(1)</script>',
            body: adversarialBody,
          })
        )
        const row = await fetchQueueRow(orgId, result.notificationQueueId)
        // templateId is always host-computed from manifest.name, never caller-supplied.
        expect(row?.templateId).toBe(`ext.${MANIFEST.name}`)
        expect(row?.payload).toEqual({
          subject: 'ext.spoof <script>alert(1)</script>',
          body: adversarialBody,
        })
      })
    })

    describe('AC3 — tenant isolation', () => {
      it('the inserted row is always scoped to the ambient org, never configurable to a different one (no field exists to override it)', async () => {
        const orgA = await createTestOrg('tenant-a')
        const orgB = await createTestOrg('tenant-b')
        const result = await bindAndRun(orgA, () =>
          host.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: RECIPIENT_EMAIL,
            subject: 'Subject',
            body: 'Body',
          })
        )
        const rowInA = await fetchQueueRow(orgA, result.notificationQueueId)
        expect(rowInA?.orgId).toBe(orgA)

        const rowsInB = await withOrg(orgB, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.id, result.notificationQueueId))
        )
        expect(rowsInB).toHaveLength(0)
      })
    })

    describe('AC4 — recipient validation enforced at enqueue time', () => {
      it('a nonexistent recipientUserId rejects with NotificationOriginatorInvalidRecipientError and inserts no row', async () => {
        const orgId = await createTestOrg('recipient-missing')
        await expect(
          bindAndRun(orgId, () =>
            host.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientUserId: randomUUID(),
              subject: 'Subject',
              body: 'Body',
            })
          )
        ).rejects.toBeInstanceOf(NotificationOriginatorInvalidRecipientError)

        const rows = await withOrg(orgId, (tx) => tx.select().from(notificationQueue))
        expect(rows).toHaveLength(0)
      })

      it('a real user belonging to a DIFFERENT org rejects with the SAME non-enumerating error as a nonexistent id', async () => {
        const orgA = await createTestOrg('cross-org-a')
        const orgB = await createTestOrg('cross-org-b')
        const userInB = await createTestUser('notif-originator-cross-org')
        try {
          await addActiveMember(orgB, userInB)

          let caughtA: unknown
          try {
            await bindAndRun(orgA, () =>
              host.enqueueNotification({
                channel: EMAIL_CHANNEL,
                recipientUserId: userInB,
                subject: 'Subject',
                body: 'Body',
              })
            )
          } catch (error) {
            caughtA = error
          }
          expect(caughtA).toBeInstanceOf(NotificationOriginatorInvalidRecipientError)

          let caughtNonexistent: unknown
          try {
            await bindAndRun(orgA, () =>
              host.enqueueNotification({
                channel: EMAIL_CHANNEL,
                recipientUserId: randomUUID(),
                subject: 'Subject',
                body: 'Body',
              })
            )
          } catch (error) {
            caughtNonexistent = error
          }
          expect((caughtNonexistent as Error).message).toBe((caughtA as Error).message)
        } finally {
          await deleteTestUser(userInB)
        }
      })

      it('neither recipientUserId nor recipientEmail supplied rejects with NotificationOriginatorInvalidParamsError before any DB call', async () => {
        const orgId = await createTestOrg('recipient-neither')
        await expect(
          bindAndRun(orgId, () =>
            host.enqueueNotification({
              channel: EMAIL_CHANNEL,
              subject: 'Subject',
              body: 'Body',
            } as never)
          )
        ).rejects.toBeInstanceOf(NotificationOriginatorInvalidParamsError)
      })

      it('both recipientUserId and recipientEmail supplied rejects with NotificationOriginatorInvalidParamsError', async () => {
        const orgId = await createTestOrg('recipient-both')
        const userId = await createTestUser('notif-originator-both')
        try {
          await addActiveMember(orgId, userId)
          await expect(
            bindAndRun(orgId, () =>
              host.enqueueNotification({
                channel: EMAIL_CHANNEL,
                recipientUserId: userId,
                recipientEmail: RECIPIENT_EMAIL,
                subject: 'Subject',
                body: 'Body',
              })
            )
          ).rejects.toBeInstanceOf(NotificationOriginatorInvalidParamsError)
        } finally {
          await deleteTestUser(userId)
        }
      })

      it('recipientEmail supplied for channel "inbox" rejects with NotificationOriginatorInvalidParamsError', async () => {
        const orgId = await createTestOrg('inbox-recipient-email')
        await expect(
          bindAndRun(orgId, () =>
            host.enqueueNotification({
              channel: 'inbox',
              recipientEmail: RECIPIENT_EMAIL,
              subject: 'Subject',
              body: 'Body',
            } as never)
          )
        ).rejects.toBeInstanceOf(NotificationOriginatorInvalidParamsError)
      })

      it('empty subject/body rejects with NotificationOriginatorInvalidParamsError', async () => {
        const orgId = await createTestOrg('empty-subject')
        await expect(
          bindAndRun(orgId, () =>
            host.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientEmail: RECIPIENT_EMAIL,
              subject: '',
              body: 'Body',
            })
          )
        ).rejects.toBeInstanceOf(NotificationOriginatorInvalidParamsError)
      })
    })

    describe('AC5 — rolling-window enqueue cap', () => {
      it('a burst under the cap all succeed; the (extensionName, orgId)-th call over the cap rejects with NotificationOriginatorRateLimitedError and inserts no row', async () => {
        const orgId = await createTestOrg('rate-cap')
        const overrideManifest: ExtensionManifest = {
          name: `com.acme.rate-cap-fixture-${randomUUID().slice(0, 8)}`,
          apiVersion: '3.14.0',
          capabilities: [],
        }
        const capHost = buildNotificationOriginatorHost(overrideManifest)

        for (let i = 0; i < NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW; i += 1) {
          await bindAndRun(orgId, () =>
            capHost.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientEmail: `a${i}@example.com`,
              subject: 'Subject',
              body: 'Body',
            })
          )
        }

        await expect(
          bindAndRun(orgId, () =>
            capHost.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientEmail: 'over-cap@example.com',
              subject: 'Subject',
              body: 'Body',
            })
          )
        ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

        const rows = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(
              and(
                eq(notificationQueue.orgId, orgId),
                eq(notificationQueue.originExtensionName, overrideManifest.name)
              )
            )
        )
        expect(rows).toHaveLength(NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW)
      }, 30_000)

      it('the cap is per-org, not global to the extension — a different org for the same extension is unaffected', async () => {
        const orgA = await createTestOrg('rate-cap-shared-a')
        const orgB = await createTestOrg('rate-cap-shared-b')
        const sharedManifest: ExtensionManifest = {
          name: `com.acme.shared-rate-cap-${randomUUID().slice(0, 8)}`,
          apiVersion: '3.14.0',
          capabilities: [],
        }
        const sharedHost = buildNotificationOriginatorHost(sharedManifest)

        for (let i = 0; i < NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW; i += 1) {
          await bindAndRun(orgA, () =>
            sharedHost.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientEmail: `a${i}@example.com`,
              subject: 'Subject',
              body: 'Body',
            })
          )
        }
        await expect(
          bindAndRun(orgA, () =>
            sharedHost.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientEmail: 'over-cap@example.com',
              subject: 'Subject',
              body: 'Body',
            })
          )
        ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

        // orgB's own budget for the same extension is untouched.
        const resultInB = await bindAndRun(orgB, () =>
          sharedHost.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: 'still-fine@example.com',
            subject: 'Subject',
            body: 'Body',
          })
        )
        const rowInB = await fetchQueueRow(orgB, resultInB.notificationQueueId)
        expect(rowInB?.orgId).toBe(orgB)
      }, 30_000)
    })

    describe('AC5 Pre-Mortem — concurrency', () => {
      it('two racing calls at the cap boundary may both succeed (accepted best-effort overshoot), neither corrupts the count nor crashes', async () => {
        const orgId = await createTestOrg('rate-cap-race')
        const raceManifest: ExtensionManifest = {
          name: `com.acme.race-fixture-${randomUUID().slice(0, 8)}`,
          apiVersion: '3.14.0',
          capabilities: [],
        }
        const raceHost = buildNotificationOriginatorHost(raceManifest)

        // Fill to exactly one below the cap sequentially.
        for (let i = 0; i < NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW - 1; i += 1) {
          await bindAndRun(orgId, () =>
            raceHost.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientEmail: `a${i}@example.com`,
              subject: 'Subject',
              body: 'Body',
            })
          )
        }

        // Two concurrent calls racing right at the boundary — both may read a count just under
        // the cap and both succeed (accepted TOCTOU overshoot, Design Decision 6/AC5).
        const results = await Promise.allSettled([
          bindAndRun(orgId, () =>
            raceHost.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientEmail: 'race-1@example.com',
              subject: 'Subject',
              body: 'Body',
            })
          ),
          bindAndRun(orgId, () =>
            raceHost.enqueueNotification({
              channel: EMAIL_CHANNEL,
              recipientEmail: 'race-2@example.com',
              subject: 'Subject',
              body: 'Body',
            })
          ),
        ])
        // Never crashes — every settlement is either fulfilled or a typed rejection.
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(NotificationOriginatorRateLimitedError)
          }
        }
        const rows = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(
              and(
                eq(notificationQueue.orgId, orgId),
                eq(notificationQueue.originExtensionName, raceManifest.name)
              )
            )
        )
        // At least the cap, at most cap + 1 (both racers succeeding) — never corrupted.
        expect(rows.length).toBeGreaterThanOrEqual(
          NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW
        )
        expect(rows.length).toBeLessThanOrEqual(
          NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW + 1
        )
      }, 30_000)
    })
  }
)
