import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditStorageQuotaConfig, orgMemberships, users } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerPlatformOperator } from '../../__tests__/helpers/platform-operator-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import type { createApp } from '../../app.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'platform-admin-audit-quota-passphrase'
const E2E_PASS_VALUE = 'correct-horse-battery-staple'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

function quotaUrl(orgId: string) {
  return `/api/v1/admin/orgs/${orgId}/audit-quota`
}

async function putQuota(
  app: TestApp,
  cookies: CookieJar,
  orgId: string,
  payload: Record<string, unknown>
) {
  return app.inject({
    method: 'PUT',
    url: quotaUrl(orgId),
    headers: { cookie: cookieHeader(cookies) },
    payload,
  })
}

async function makeOperator(prefix: string) {
  return registerPlatformOperator(suite.app, {
    emailPrefix: prefix,
    orgNamePrefix: `${prefix}-org`,
    password: E2E_PASS_VALUE,
  })
}

describe.sequential('Story 22.3 PUT /admin/orgs/:orgId/audit-quota', () => {
  suite.registerLifecycle()

  it('AC-3: 401 with no auth header', async () => {
    const res = await suite.app.inject({
      method: 'PUT',
      url: quotaUrl(randomUUID()),
      payload: { quotaBytes: 1000 },
    })
    expect(res.statusCode).toBe(401)
  })

  it('Story 9.8: 403 mfa_required for an unenrolled platform operator', async () => {
    const registered = await registerAndLoginViaApi(suite.app, {
      email: `audit-quota-no-mfa-${randomUUID()}@example.com`,
      password: E2E_PASS_VALUE,
      orgName: `Audit Quota No MFA ${randomUUID()}`,
    })
    await getDb().transaction(async (tx) => {
      await tx
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.isPlatformOperator, true))
      await tx
        .update(users)
        .set({ isPlatformOperator: true })
        .where(eq(users.id, registered.userId))
    })
    await withOrg(registered.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(orgMemberships.userId, registered.userId))
    )
    const res = await putQuota(suite.app, registered.cookies, registered.orgId, {
      quotaBytes: 1_000_000,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('AC-9: 403 platform_operator_required for an enrolled non-operator, and setOrgAuditQuota never runs (config row absent)', async () => {
    const { enrollUserWithMfa } = await import('../../__tests__/helpers/mfa-enroll-test-helpers.js')
    const nonOperator = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'audit-quota-non-operator',
      orgNamePrefix: 'Audit Quota Non Operator',
      password: E2E_PASS_VALUE,
    })

    await withTestOrg(async ({ orgId }) => {
      const res = await putQuota(suite.app, nonOperator.cookies, orgId, { quotaBytes: 500_000 })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'platform_operator_required' })

      // The unauthorized caller must never cause app.current_org_id to be set / a config row to
      // be written for the target org, even transiently.
      const rows = await withOrg(orgId, (tx) =>
        tx.select().from(auditStorageQuotaConfig).where(eq(auditStorageQuotaConfig.orgId, orgId))
      )
      expect(rows).toHaveLength(0)
    })
  })

  it('AC-9: an org Owner/Admin acting on their OWN org still gets 403 — no allowedRoles escape hatch', async () => {
    const { enrollUserWithMfa } = await import('../../__tests__/helpers/mfa-enroll-test-helpers.js')
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'audit-quota-owner',
      orgNamePrefix: 'Audit Quota Owner',
      password: E2E_PASS_VALUE,
    })

    const res = await putQuota(suite.app, owner.cookies, owner.orgId, {
      quotaBytes: 1_000_000,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'platform_operator_required' })
  })

  it('AC-3: 404 org_not_found for a nonexistent orgId, checked before AC-4s overcommit calculation', async () => {
    const operator = await makeOperator(`audit-quota-404-${randomUUID()}`)
    const res = await putQuota(suite.app, operator.cookies, randomUUID(), {
      // A huge value that WOULD trip the overcommit check if the 404 guard didn't run first.
      quotaBytes: 40 * 1024 ** 3,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'org_not_found' })
  })

  it('AC-3 positive: set from unconfigured', async () => {
    const operator = await makeOperator(`audit-quota-set-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const res = await putQuota(suite.app, operator.cookies, orgId, {
        quotaBytes: 500_000_000,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ quotaBytes: number; state: string }>()
      expect(body.quotaBytes).toBe(500_000_000)
    })
  })

  it('AC-3 positive: clear to unlimited via quotaBytes: null', async () => {
    const operator = await makeOperator(`audit-quota-clear-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      // Seed a RECONCILED (not stale) usage row via a committed, separate connection (withOrg,
      // not withTestOrg's own still-open outer transaction) so the HTTP request below — issued
      // on the app's own connection pool — actually sees it, and this org's resulting `state`
      // is deterministically `unlimited` rather than `stale` (AC-2: `lastReconciledAt: null`
      // outranks `unlimited`).
      const { sql } = await import('drizzle-orm')
      await withOrg(orgId, (tx) =>
        tx.execute(sql`
          INSERT INTO audit_org_storage_usage (org_id, bytes_used, last_reconciled_at)
          VALUES (${orgId}, 0, now())
          ON CONFLICT (org_id) DO UPDATE SET last_reconciled_at = now()
        `)
      )

      await putQuota(suite.app, operator.cookies, orgId, { quotaBytes: 300_000_000 })
      const res = await putQuota(suite.app, operator.cookies, orgId, { quotaBytes: null })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ quotaBytes: number | null; state: string }>()
      expect(body.quotaBytes).toBeNull()
      expect(body.state).toBe('unlimited')

      const rows = await withOrg(orgId, (tx) =>
        tx.select().from(auditStorageQuotaConfig).where(eq(auditStorageQuotaConfig.orgId, orgId))
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.quotaBytes).toBeNull()
    })
  })

  it('AC-3 positive: both quotaBytes and writeRatePerMinute set in one call', async () => {
    const operator = await makeOperator(`audit-quota-both-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const res = await putQuota(suite.app, operator.cookies, orgId, {
        quotaBytes: 1_073_741_824,
        writeRatePerMinute: 500,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ quotaBytes: number; writeRatePerMinute: number }>()
      expect(body.quotaBytes).toBe(1_073_741_824)
      expect(body.writeRatePerMinute).toBe(500)
    })
  })

  it('AC-3 positive: remediation-deadlock — raising a fully-exhausted org succeeds at the route layer', async () => {
    // registerPlatformOperator() demotes any existing sole platform operator (AC-9's "at most
    // one instance-wide" invariant) — register+use the first operator BEFORE registering the
    // second, so the second registration's demotion doesn't invalidate the first's session mid-test.
    const exhaustingOperator = await makeOperator(`audit-quota-deadlock-a-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const exhaust = await putQuota(suite.app, exhaustingOperator.cookies, orgId, {
        quotaBytes: 1,
      })
      expect(exhaust.statusCode).toBe(200)

      const raisingOperator = await makeOperator(`audit-quota-deadlock-b-${randomUUID()}`)
      const raise = await putQuota(suite.app, raisingOperator.cookies, orgId, {
        quotaBytes: 1_000_000,
      })
      expect(raise.statusCode).toBe(200)
      expect(raise.json<{ quotaBytes: number }>().quotaBytes).toBe(1_000_000)
    })
  })

  it('AC-3 positive: quota below current usage succeeds — no server-side "helpful" rejection, and the row reflects blocked state', async () => {
    const operator = await makeOperator(`audit-quota-below-usage-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      // Give the org some recorded usage directly (bypassing the write path, which is out of
      // this story's scope), via a COMMITTED, separate connection (withOrg, not withTestOrg's
      // own still-open outer transaction) so the HTTP request below actually observes it.
      const { sql } = await import('drizzle-orm')
      await withOrg(orgId, (tx) =>
        tx.execute(sql`
          INSERT INTO audit_org_storage_usage (org_id, bytes_used, last_reconciled_at)
          VALUES (${orgId}, 10000, now())
          ON CONFLICT (org_id) DO UPDATE SET bytes_used = 10000, last_reconciled_at = now()
        `)
      )
      const res = await putQuota(suite.app, operator.cookies, orgId, { quotaBytes: 100 })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ quotaBytes: number; state: string }>()
      expect(body.quotaBytes).toBe(100)
      expect(body.state).toBe('blocked')
    })
  })

  it('AC-3 edge: quotaBytes 0 -> 422', async () => {
    const operator = await makeOperator(`audit-quota-zero-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const res = await putQuota(suite.app, operator.cookies, orgId, { quotaBytes: 0 })
      expect(res.statusCode).toBe(422)
    })
  })

  it('AC-3 edge: quotaBytes -5 -> 422', async () => {
    const operator = await makeOperator(`audit-quota-neg-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const res = await putQuota(suite.app, operator.cookies, orgId, { quotaBytes: -5 })
      expect(res.statusCode).toBe(422)
    })
  })

  it('AC-3 edge: writeRatePerMinute 0 -> 422', async () => {
    const operator = await makeOperator(`audit-quota-rate-zero-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const res = await putQuota(suite.app, operator.cookies, orgId, { writeRatePerMinute: 0 })
      expect(res.statusCode).toBe(422)
    })
  })

  it('AC-3 edge (Boundary Sweep): quotaBytes beyond Number.MAX_SAFE_INTEGER -> 422', async () => {
    const operator = await makeOperator(`audit-quota-unsafe-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const res = await putQuota(suite.app, operator.cookies, orgId, {
        quotaBytes: Number.MAX_SAFE_INTEGER + 1024,
      })
      expect(res.statusCode).toBe(422)
    })
  })

  it('AC-4: raising into overcommit territory is rejected with 422 quota_overcommit, then succeeds when acknowledged', async () => {
    const operator = await makeOperator(`audit-quota-overcommit-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      // 20 GiB logical * default 3.0x estimate = 60 GiB physical, well over 80% of the default
      // 50 GB instance limit (40 GB threshold) — regardless of any other orgs' existing quotas
      // (the sum only ever adds).
      const bigQuota = 20 * 1024 ** 3
      const rejected = await putQuota(suite.app, operator.cookies, orgId, {
        quotaBytes: bigQuota,
      })
      expect(rejected.statusCode).toBe(422)
      const rejectedBody = rejected.json<{
        code: string
        allocatedLogicalBytes: number
        estimatedPhysicalBytes: number
        instanceLimitBytes: number
        requestedBytes: number
      }>()
      expect(rejectedBody.code).toBe('quota_overcommit')
      expect(rejectedBody.requestedBytes).toBe(bigQuota)
      expect(rejectedBody.estimatedPhysicalBytes).toBeGreaterThan(
        rejectedBody.instanceLimitBytes * 0.8
      )

      // No row should have been written for the rejected request.
      const rowsAfterReject = await withOrg(orgId, (tx) =>
        tx.select().from(auditStorageQuotaConfig).where(eq(auditStorageQuotaConfig.orgId, orgId))
      )
      expect(rowsAfterReject).toHaveLength(0)

      const acknowledged = await putQuota(suite.app, operator.cookies, orgId, {
        quotaBytes: bigQuota,
        acknowledgeOvercommit: true,
      })
      expect(acknowledged.statusCode).toBe(200)
      expect(acknowledged.json<{ quotaBytes: number }>().quotaBytes).toBe(bigQuota)
    })
  })

  it('AC-4: lowering a quota never triggers the overcommit check, even on an already-overcommitted instance', async () => {
    const operator = await makeOperator(`audit-quota-lower-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const bigQuota = 20 * 1024 ** 3
      const setup = await putQuota(suite.app, operator.cookies, orgId, {
        quotaBytes: bigQuota,
        acknowledgeOvercommit: true,
      })
      expect(setup.statusCode).toBe(200)

      const lowered = await putQuota(suite.app, operator.cookies, orgId, {
        quotaBytes: 1024,
      })
      expect(lowered.statusCode).toBe(200)
      expect(lowered.json<{ quotaBytes: number }>().quotaBytes).toBe(1024)
    })
  })

  it('AC-4: the overcommit acknowledgement is recorded in the audit payload', async () => {
    const operator = await makeOperator(`audit-quota-ack-audit-${randomUUID()}`)
    await withTestOrg(async ({ orgId }) => {
      const bigQuota = 25 * 1024 ** 3
      const res = await putQuota(suite.app, operator.cookies, orgId, {
        quotaBytes: bigQuota,
        acknowledgeOvercommit: true,
      })
      expect(res.statusCode).toBe(200)

      const { auditLogEntries } = await import('@project-vault/db/schema')
      const { AuditEvent } = await import('@project-vault/shared')
      const orgRows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(
            and(
              eq(auditLogEntries.orgId, orgId),
              eq(auditLogEntries.eventType, AuditEvent.AUDIT_QUOTA_CONFIGURED)
            )
          )
      )
      expect(orgRows.length).toBeGreaterThan(0)
      const last = orgRows[orgRows.length - 1]
      expect(last?.payload).toMatchObject({ overcommitAcknowledged: true })
    })
  })
})
