import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares, notificationQueue } from '@project-vault/db/schema'
import { cookieHeader } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createMembershipTestHelpers,
  MEMBERSHIP_TEST_LOGIN_SECRET,
} from '../../__tests__/helpers/membership-test-helpers.js'
import {
  createCredentialTestProject,
  createCredentialViaApi,
  type CredentialRouteTestApp,
} from '../credentials/credential-route-test-helpers.js'
import { flushPendingLosingAttempts } from './external-service.js'
import { VERIFICATION_CODE_TEMPLATE_ID } from './external-verification-service.js'
import { generateAndHashShareToken } from './service.js'

type ShareRow = typeof credentialShares.$inferSelect
export type ShareOverrides = Partial<typeof credentialShares.$inferInsert>

export type ExternalShareSeeder = {
  orgId: string
  /** The recipient address every seeded row carries (cloned from the template share). */
  recipientEmail: string
  /** Inserts one fresh external share row cloned from a real one, with `overrides` applied (the
   *  default is an active share expiring in 30 minutes), and returns its raw token. A seeded row
   *  is a link-only share (`verificationRequired: false`, like every share created before Story
   *  72-11 and every host-created share) unless the overrides say otherwise. */
  seedShare: (overrides?: ShareOverrides) => Promise<{ id: string; token: string }>
  readShare: (id: string) => Promise<ShareRow | undefined>
  countAuditRows: (eventType: string, shareId: string) => Promise<number>
}

/**
 * Story 65.4: boots one owner/project/credential through the real API, creates one real external
 * share to use as a template, and then seeds further rows of any status directly in the DB. Direct
 * seeding is what lets a test have hundreds of independent shares in every miss class (active but
 * past `expiresAt`, expired, revoked, viewed, superseded) without tripping the per-credential
 * pending-share cap.
 */
export async function createExternalShareSeeder(
  app: CredentialRouteTestApp,
  registerOwner: ReturnType<typeof createMembershipTestHelpers>['registerOwner'],
  label: string
): Promise<ExternalShareSeeder> {
  const sharer = await registerOwner(app, `${label}-sharer`)
  const projectId = await createCredentialTestProject(app, sharer.cookies, label)
  const credential = await createCredentialViaApi(app, sharer.cookies, projectId)
  const recipientEmail = `${label}@vendor.example`
  const create = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials/${credential.id}/external-shares`,
    headers: { cookie: cookieHeader(sharer.cookies) },
    payload: {
      recipientEmail,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      password: MEMBERSHIP_TEST_LOGIN_SECRET,
    },
  })
  expect(create.statusCode).toBe(201)
  const { id: templateId } = create.json<{ data: { id: string } }>().data
  const orgId = sharer.orgId
  const readShare = async (id: string) => {
    const [row] = await withOrg(orgId, (tx) =>
      tx.select().from(credentialShares).where(eq(credentialShares.id, id))
    )
    return row
  }
  const template = await readShare(templateId)
  if (!template) throw new Error('template external share missing')

  return {
    orgId,
    recipientEmail,
    readShare,
    async seedShare(overrides = {}) {
      const { rawToken, tokenHash } = generateAndHashShareToken()
      const id = randomUUID()
      await withOrg(orgId, (tx) =>
        tx.insert(credentialShares).values({
          ...template,
          id,
          tokenHash,
          status: 'active',
          revealAttemptCount: 0,
          verificationRequired: false,
          ...overrides,
        })
      )
      return { id, token: rawToken }
    },
    async countAuditRows(eventType, shareId) {
      const rows = await withOrg(orgId, (tx) =>
        tx.select().from(auditLogEntries).where(eq(auditLogEntries.eventType, eventType))
      )
      return rows.filter((row) => row.resourceId === shareId).length
    },
  }
}

/** Story 72-11: the code of the newest verification email queued for `recipientEmail`, read from
 *  the queue row the way a mailbox would receive it (the test stands in for the recipient). */
export async function readQueuedVerificationCode(
  orgId: string,
  recipientEmail: string
): Promise<string | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ payload: notificationQueue.payload })
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.templateId, VERIFICATION_CODE_TEMPLATE_ID),
          eq(notificationQueue.recipientEmail, recipientEmail.toLowerCase())
        )
      )
      .orderBy(desc(notificationQueue.createdAt))
      .limit(1)
  )
  const code = (row?.payload as Record<string, unknown> | undefined)?.['code']
  return typeof code === 'string' ? code : undefined
}

let verificationIpCounter = 0

/** A fresh source address per call, so the per-IP route limits never interfere with a test. */
export function nextVerificationTestAddress(): string {
  verificationIpCounter += 1
  return `10.72.${(verificationIpCounter >> 8) & 255}.${verificationIpCounter & 255}`
}

/**
 * Story 72-11: runs the guest's verification step for a gated external share through the real
 * routes (request a code, read it from the queued email, confirm it) and returns the one-time
 * proof the reveal requires.
 */
export async function verifyExternalShareForTest(
  app: CredentialRouteTestApp,
  params: { orgId: string; token: string; recipientEmail: string }
): Promise<string> {
  const base = `/api/v1/external-shares/access/${params.token}/verification`
  const send = await app.inject({
    method: 'POST',
    url: base,
    remoteAddress: nextVerificationTestAddress(),
  })
  expect(send.statusCode).toBe(200)
  await flushPendingLosingAttempts()
  const code = await readQueuedVerificationCode(params.orgId, params.recipientEmail)
  if (!code) throw new Error('no verification code was queued for the share')
  const confirm = await app.inject({
    method: 'POST',
    url: `${base}/confirm`,
    remoteAddress: nextVerificationTestAddress(),
    payload: { code },
  })
  expect(confirm.statusCode).toBe(200)
  return confirm.json<{ data: { proof: string } }>().data.proof
}
