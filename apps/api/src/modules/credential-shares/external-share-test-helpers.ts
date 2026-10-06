import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares } from '@project-vault/db/schema'
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
import { generateAndHashShareToken } from './service.js'

type ShareRow = typeof credentialShares.$inferSelect
export type ShareOverrides = Partial<typeof credentialShares.$inferInsert>

export type ExternalShareSeeder = {
  orgId: string
  /** Inserts one fresh external share row cloned from a real one, with `overrides` applied (the
   *  default is an active share expiring in 30 minutes), and returns its raw token. */
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
  const create = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials/${credential.id}/external-shares`,
    headers: { cookie: cookieHeader(sharer.cookies) },
    payload: {
      recipientEmail: `${label}@vendor.example`,
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
