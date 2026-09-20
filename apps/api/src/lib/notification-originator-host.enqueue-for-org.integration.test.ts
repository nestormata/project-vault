import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb, withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships, organizations } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  NotificationOriginatorInvalidRecipientError,
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

/**
 * Story 58.1 — real-Postgres/RLS integration coverage for `enqueueNotificationForOrg`, the
 * out-of-request sibling added by this story. Mirrors
 * `notification-originator-host.integration.test.ts`'s own fixture/helper precedent (Story 36.1),
 * but covers the ACs that specifically require real committed rows across two orgs/two
 * rate-limit windows and are therefore not meaningfully mockable:
 *
 * - AC3: cross-tenant recipient rejection, both directions, with a zero-row-inserted proof.
 * - AC5: the out-of-request budget's own independence from the in-request budget, in both
 *   directions, including the simultaneous-boundary case (both budgets at 99/100 at once).
 * - AC2: the "soft-deleted membership" edge case — confirmed against real source (Task 3):
 *   `org_memberships` has no separate soft-delete column; its `status` check constraint only
 *   allows `'active'`/`'deactivated'`. A `'deactivated'` row IS this codebase's soft-delete
 *   equivalent, and `assertRecipientIsOrgMember`'s underlying `resolveActiveOrgRole()` query
 *   already excludes it (its `WHERE status = 'active'` filter), reused verbatim here — proven
 *   against a real deactivated row, not just an absent one.
 */

configureAuthIntegrationEnv()

const { initVault } = await import('../modules/vault/key-service.js')

const TEST_PASSPHRASE = 'notification-originator-host-enqueue-for-org-integration-tests-passphrase'

const EMAIL_CHANNEL = 'email' as const

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.enqueue-for-org-integration-fixture',
  apiVersion: '3.21.0',
  capabilities: [],
}

async function createTestOrg(label: string): Promise<string> {
  const orgName = `NotifOriginatorForOrg ${label} ${randomUUID()}`
  const [org] = await getDb()
    .insert(organizations)
    .values({ name: orgName, slug: orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-') })
    .returning({ id: organizations.id })
  if (!org) throw new Error('createTestOrg: org insert returned no row')
  return org.id
}

async function addMember(
  orgId: string,
  userId: string,
  status: 'active' | 'deactivated' = 'active',
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'member'
): Promise<void> {
  await withOrg(orgId, (tx) => tx.insert(orgMemberships).values({ orgId, userId, role, status }))
}

async function fetchQueueRows(orgId: string) {
  return withOrg(orgId, (tx) =>
    tx.select().from(notificationQueue).where(eq(notificationQueue.orgId, orgId))
  )
}

describe('buildNotificationOriginatorHost.enqueueNotificationForOrg — Story 58.1 real-Postgres/RLS integration', () => {
  const host = buildNotificationOriginatorHost(MANIFEST)

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  describe('AC1 — succeeds with zero ambient request context bound', () => {
    it('inserts a pending row with enqueuedOutOfRequest: true, never calling bindRequestContext', async () => {
      const orgId = await createTestOrg('ac1-happy')
      const userId = await createTestUser('notif-for-org-ac1-happy')
      try {
        await addMember(orgId, userId)

        const result = await host.enqueueNotificationForOrg({
          organizationId: orgId,
          channel: EMAIL_CHANNEL,
          recipientUserId: userId,
          subject: 'Endpoint down',
          body: 'https://api.example.com has been unreachable for 3 consecutive checks.',
        })

        const rows = await fetchQueueRows(orgId)
        const row = rows.find((r) => r.id === result.notificationQueueId)
        expect(row?.status).toBe('pending')
        expect(row?.templateId).toBe(`ext.${MANIFEST.name}`)
        expect(row?.channel).toBe('email')
        expect(row?.enqueuedOutOfRequest).toBe(true)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  describe('AC2 — soft-deleted/deactivated membership rejection', () => {
    it('a recipientUserId resolving to a real but deactivated membership row rejects with NotificationOriginatorInvalidRecipientError', async () => {
      const orgId = await createTestOrg('ac2-deactivated')
      const userId = await createTestUser('notif-for-org-ac2-deactivated')
      try {
        await addMember(orgId, userId, 'deactivated')

        await expect(
          host.enqueueNotificationForOrg({
            organizationId: orgId,
            channel: EMAIL_CHANNEL,
            recipientUserId: userId,
            subject: 'Subject',
            body: 'Body',
          })
        ).rejects.toBeInstanceOf(NotificationOriginatorInvalidRecipientError)

        const rows = await fetchQueueRows(orgId)
        expect(rows).toHaveLength(0)
      } finally {
        await deleteTestUser(userId)
      }
    })
  })

  describe('AC3 — cross-tenant recipient scoping, both directions', () => {
    it.each([
      ['org-A named, recipient only in org-B', 'A', 'B'],
      ['org-B named, recipient only in org-A', 'B', 'A'],
    ])('%s: rejects and inserts no row', async (_label, namedLabel, recipientLabel) => {
      const orgA = await createTestOrg('ac3-a')
      const orgB = await createTestOrg('ac3-b')
      const orgs = { A: orgA, B: orgB }
      const userInRecipientOrg = await createTestUser(`notif-for-org-ac3-${recipientLabel}`)
      try {
        await addMember(orgs[recipientLabel as 'A' | 'B'], userInRecipientOrg)

        const namedOrgId = orgs[namedLabel as 'A' | 'B']
        await expect(
          host.enqueueNotificationForOrg({
            organizationId: namedOrgId,
            channel: EMAIL_CHANNEL,
            recipientUserId: userInRecipientOrg,
            subject: 'Subject',
            body: 'Body',
          })
        ).rejects.toBeInstanceOf(NotificationOriginatorInvalidRecipientError)

        const rows = await fetchQueueRows(namedOrgId)
        expect(rows).toHaveLength(0)
      } finally {
        await deleteTestUser(userInRecipientOrg)
      }
    })
  })

  describe('AC5 — independent out-of-request rolling-window budget', () => {
    it('a burst under the cap all succeed; the call over the cap rejects, inserting no row, without affecting a fresh in-request call for the same (extension, org)', async () => {
      const orgId = await createTestOrg('ac5-independent')
      const fixtureManifest: ExtensionManifest = {
        name: `com.acme.ac5-independent-${randomUUID().slice(0, 8)}`,
        apiVersion: '3.21.0',
        capabilities: [],
      }
      const fixtureHost = buildNotificationOriginatorHost(fixtureManifest)

      for (let i = 0; i < NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW; i += 1) {
        await fixtureHost.enqueueNotificationForOrg({
          organizationId: orgId,
          channel: EMAIL_CHANNEL,
          recipientEmail: `a${i}@example.com`,
          subject: 'Subject',
          body: 'Body',
        })
      }

      await expect(
        fixtureHost.enqueueNotificationForOrg({
          organizationId: orgId,
          channel: EMAIL_CHANNEL,
          recipientEmail: 'over-cap@example.com',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

      const outOfRequestRows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(notificationQueue)
          .where(
            and(
              eq(notificationQueue.orgId, orgId),
              eq(notificationQueue.originExtensionName, fixtureManifest.name),
              eq(notificationQueue.enqueuedOutOfRequest, true)
            )
          )
      )
      expect(outOfRequestRows).toHaveLength(NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW)

      // The in-request budget for the SAME (extension, org) pair is untouched — proven by a
      // real in-request call succeeding right after the out-of-request budget was exhausted.
      // Note: enqueueNotification resolves its org ambiently, so this exercises the SAME
      // orgId/extensionName pair without needing bindRequestContext plumbing here (the
      // in-request host is exercised directly via a bound context below).
      const { runWithRequestContext } = await import('./request-context.js')
      const inRequestResult = await runWithRequestContext({ orgId, userId: randomUUID() }, () =>
        fixtureHost.enqueueNotification({
          channel: EMAIL_CHANNEL,
          recipientEmail: 'still-fine-in-request@example.com',
          subject: 'Subject',
          body: 'Body',
        })
      )
      expect(inRequestResult.notificationQueueId).toBeTruthy()
    }, 30_000)

    it('exhausting the IN-REQUEST budget first does not block a subsequent out-of-request call for the same (extension, org)', async () => {
      const orgId = await createTestOrg('ac5-reverse-independent')
      const fixtureManifest: ExtensionManifest = {
        name: `com.acme.ac5-reverse-${randomUUID().slice(0, 8)}`,
        apiVersion: '3.21.0',
        capabilities: [],
      }
      const fixtureHost = buildNotificationOriginatorHost(fixtureManifest)
      const { runWithRequestContext } = await import('./request-context.js')

      for (let i = 0; i < NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW; i += 1) {
        await runWithRequestContext({ orgId, userId: randomUUID() }, () =>
          fixtureHost.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: `a${i}@example.com`,
            subject: 'Subject',
            body: 'Body',
          })
        )
      }
      await expect(
        runWithRequestContext({ orgId, userId: randomUUID() }, () =>
          fixtureHost.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: 'over-cap-in-request@example.com',
            subject: 'Subject',
            body: 'Body',
          })
        )
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

      // The out-of-request budget for the SAME (extension, org) pair is untouched.
      const outOfRequestResult = await fixtureHost.enqueueNotificationForOrg({
        organizationId: orgId,
        channel: EMAIL_CHANNEL,
        recipientEmail: 'still-fine-out-of-request@example.com',
        subject: 'Subject',
        body: 'Body',
      })
      expect(outOfRequestResult.notificationQueueId).toBeTruthy()
    }, 30_000)

    it("simultaneous-boundary independence: both budgets at 99/100 at once — the 100th call on EACH path succeeds, the 101st on EACH path rejects, and neither path's COUNT is corrupted by the other", async () => {
      const orgId = await createTestOrg('ac5-simultaneous-boundary')
      const fixtureManifest: ExtensionManifest = {
        name: `com.acme.ac5-simultaneous-${randomUUID().slice(0, 8)}`,
        apiVersion: '3.21.0',
        capabilities: [],
      }
      const fixtureHost = buildNotificationOriginatorHost(fixtureManifest)
      const { runWithRequestContext } = await import('./request-context.js')

      // Fill BOTH budgets to exactly one below the cap, interleaved.
      for (let i = 0; i < NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW - 1; i += 1) {
        await runWithRequestContext({ orgId, userId: randomUUID() }, () =>
          fixtureHost.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: `in-req-${i}@example.com`,
            subject: 'Subject',
            body: 'Body',
          })
        )
        await fixtureHost.enqueueNotificationForOrg({
          organizationId: orgId,
          channel: EMAIL_CHANNEL,
          recipientEmail: `oo-req-${i}@example.com`,
          subject: 'Subject',
          body: 'Body',
        })
      }

      // Both are now at 99/100 simultaneously. The 100th call on each succeeds (at the
      // boundary, not over it).
      const inRequest100th = await runWithRequestContext({ orgId, userId: randomUUID() }, () =>
        fixtureHost.enqueueNotification({
          channel: EMAIL_CHANNEL,
          recipientEmail: 'in-req-100@example.com',
          subject: 'Subject',
          body: 'Body',
        })
      )
      const outOfRequest100th = await fixtureHost.enqueueNotificationForOrg({
        organizationId: orgId,
        channel: EMAIL_CHANNEL,
        recipientEmail: 'oo-req-100@example.com',
        subject: 'Subject',
        body: 'Body',
      })
      expect(inRequest100th.notificationQueueId).toBeTruthy()
      expect(outOfRequest100th.notificationQueueId).toBeTruthy()

      // The 101st call on EACH path now rejects — proving neither path's COUNT query was
      // corrupted or fed by the other's rows.
      await expect(
        runWithRequestContext({ orgId, userId: randomUUID() }, () =>
          fixtureHost.enqueueNotification({
            channel: EMAIL_CHANNEL,
            recipientEmail: 'in-req-101@example.com',
            subject: 'Subject',
            body: 'Body',
          })
        )
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)
      await expect(
        fixtureHost.enqueueNotificationForOrg({
          organizationId: orgId,
          channel: EMAIL_CHANNEL,
          recipientEmail: 'oo-req-101@example.com',
          subject: 'Subject',
          body: 'Body',
        })
      ).rejects.toBeInstanceOf(NotificationOriginatorRateLimitedError)

      const inRequestRows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(notificationQueue)
          .where(
            and(
              eq(notificationQueue.orgId, orgId),
              eq(notificationQueue.originExtensionName, fixtureManifest.name),
              eq(notificationQueue.enqueuedOutOfRequest, false)
            )
          )
      )
      const outOfRequestRows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(notificationQueue)
          .where(
            and(
              eq(notificationQueue.orgId, orgId),
              eq(notificationQueue.originExtensionName, fixtureManifest.name),
              eq(notificationQueue.enqueuedOutOfRequest, true)
            )
          )
      )
      expect(inRequestRows).toHaveLength(NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW)
      expect(outOfRequestRows).toHaveLength(NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW)
    }, 60_000)
  })
})
