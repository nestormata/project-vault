import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditExports } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { writeHumanAuditEntry } from './human-entry.js'
import { firstActorTokenIdForUser } from './actor-token.js'
import { runAuditExport, AUDIT_EXPORT_MAX_RANGE_DAYS } from './export.js'
import { AUDIT_VERIFY_MAX_RANGE_DAYS } from './verify.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const TEST_PASSPHRASE = 'audit-export-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const EXPORT_URL = '/api/v1/org/audit/export'

async function registerOwner(app: TestApp, label: string) {
  return registerAndLoginViaApi(app, {
    email: `${label}-${randomUUID()}@example.com`,
    password: PASSWORD,
    orgName: `${label} ${randomUUID()}`,
  })
}

async function callExport(app: TestApp, cookies: Cookies, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: EXPORT_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function callStatus(app: TestApp, cookies: Cookies, jobId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/org/audit/exports/${jobId}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function callDownload(app: TestApp, cookies: Cookies, jobId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/org/audit/exports/${jobId}/download`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

function wideRange(): { from: string; to: string } {
  return {
    from: new Date(Date.now() - 3_600_000).toISOString(),
    to: new Date(Date.now() + 3_600_000).toISOString(),
  }
}

describe.sequential('audit export routes', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('accepts a valid export request, returns 202 + jobId, inserts a pending row (AC-9)', async () => {
    const owner = await registerOwner(app, 'export-happy')
    const { from, to } = wideRange()

    const res = await callExport(app, owner.cookies, {
      from,
      to,
      format: 'csv',
      includeIntegrityReport: true,
    })

    expect(res.statusCode).toBe(202)
    const body = res.json<{ data: { jobId: string; status: string } }>()
    expect(body.data.status).toBe('pending')

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(auditExports).where(eq(auditExports.id, body.data.jobId))
    )
    expect(row?.status).toBe('pending')
    expect(row?.fileContent).toBeNull()
  })

  it('validates format/range independently (AC-14)', async () => {
    const owner = await registerOwner(app, 'export-validation')
    const { from, to } = wideRange()

    const badFormat = await callExport(app, owner.cookies, { from, to, format: 'pdf' })
    expect(badFormat.statusCode).toBe(422)

    const invertedRange = await callExport(app, owner.cookies, {
      from: to,
      to: from,
      format: 'csv',
    })
    expect(invertedRange.statusCode).toBe(422)
    expect(invertedRange.json()).toMatchObject({ code: 'invalid_range' })

    const tooLarge = await callExport(app, owner.cookies, {
      from: new Date(0).toISOString(),
      to: new Date((AUDIT_EXPORT_MAX_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString(),
      format: 'csv',
    })
    expect(tooLarge.statusCode).toBe(422)
    expect(tooLarge.json()).toMatchObject({ code: 'range_too_large' })

    const missingRange = await callExport(app, owner.cookies, { format: 'csv' })
    expect(missingRange.statusCode).toBe(422)

    const countRows = await withOrg(owner.orgId, (tx) => tx.select().from(auditExports))
    expect(countRows).toHaveLength(0)
  })

  it('requires owner role — an admin (not owner) is rejected with 403 (AC-21-equivalent for export)', async () => {
    const { createDirectAuthenticatedUser } =
      await import('../../__tests__/helpers/org-role-test-helpers.js')
    const admin = await createDirectAuthenticatedUser(app, 'admin', 'admin', 'export-authz')
    const { from, to } = wideRange()
    const res = await callExport(app, admin.cookies, { from, to, format: 'csv' })
    // Role is checked before MFA (secure-route.ts's enforceProtectedGuards), so a non-owner
    // is always rejected for insufficient_role here regardless of MFA-enrollment status —
    // this test only proves the role gate; the MFA gate is proven separately below with a
    // genuine unenrolled *owner* session, which is required to even reach the MFA check.
    expect(res.statusCode).toBe(403)
  })

  it('rejects an owner session that has not completed MFA enrollment with 403 mfa_required (AC-21-equivalent for export)', async () => {
    const { createDirectAuthenticatedUser } =
      await import('../../__tests__/helpers/org-role-test-helpers.js')
    // createDirectAuthenticatedUser grants no MFA grace period, unlike registerAndLoginViaApi —
    // exercises the enforced branch of requireMfaEnrollment() directly (mirrors
    // rotation/routes.test.ts's equivalent AC-7 test for this same SecureRoute mechanism). Must
    // be an *owner* session, not admin, since role is checked before MFA and this route is
    // allowedRoles: ['owner'] — an admin session would never reach the MFA check at all.
    const unenrolledOwner = await createDirectAuthenticatedUser(app, 'owner', 'owner', 'export-mfa')
    const { from, to } = wideRange()
    const res = await callExport(app, unenrolledOwner.cookies, { from, to, format: 'csv' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('runs verification, generates CSV + integrity summary on a clean range (AC-9/10/12/13)', async () => {
    const owner = await registerOwner(app, 'export-worker-happy')
    // A real actor token, not `null` — checkAuditActorTokenCoverage (Story 8.1 D3) is a
    // database-wide gate over the shared, never-cleaned-up dev/test Postgres instance; a
    // human-actor row with a null actor_token_id would permanently fail that check for every
    // future test run.
    await withOrg(owner.orgId, async (tx) => {
      const actorTokenId = await firstActorTokenIdForUser(tx, owner.userId)
      await writeHumanAuditEntry(tx, {
        orgId: owner.orgId,
        actorTokenId,
        eventType: 'rotation.initiated',
        payload: {},
      })
    })
    const { from, to } = wideRange()
    const triggerRes = await callExport(app, owner.cookies, { from, to, format: 'csv' })
    const jobId = triggerRes.json<{ data: { jobId: string } }>().data.jobId

    await runAuditExport({ exportId: jobId, orgId: owner.orgId })

    const statusRes = await callStatus(app, owner.cookies, jobId)
    expect(statusRes.statusCode).toBe(200)
    const statusBody = statusRes.json<{
      data: {
        status: string
        downloadUrl: string | null
        rowsChecked: number
        integritySummary: { passed: number; failedCount: number }
      }
    }>().data
    expect(statusBody.status).toBe('completed')
    expect(statusBody.integritySummary.failedCount).toBe(0)
    expect(statusBody.downloadUrl).toBe(`/api/v1/org/audit/exports/${jobId}/download`)

    const downloadRes = await callDownload(app, owner.cookies, jobId)
    expect(downloadRes.statusCode).toBe(200)
    expect(downloadRes.headers['content-type']).toContain('text/csv')
    expect(downloadRes.headers['content-disposition']).toContain(`audit-export-${jobId}.csv`)
    const csv = (downloadRes as unknown as { payload: string }).payload
    expect(csv.split('\n')[0]).toBe(
      'timestamp,actor_display_name,event_type,resource_id,resource_type,org_id,project_id,ip_address'
    )
    expect(csv).toContain('--- Integrity Verification Summary ---')
  }, 20_000)

  it('fails closed on a tampered row — no CSV generated or stored (AC-11)', async () => {
    const owner = await registerOwner(app, 'export-tampered')
    const { from, to } = wideRange()
    // Insert a self-inconsistent HMAC row directly, mirroring Story 8.1 AC-2's technique.
    await withOrg(owner.orgId, (tx) =>
      tx.execute(sql`
        INSERT INTO audit_log_entries (org_id, actor_type, event_type, key_version, hmac, payload)
        VALUES (${owner.orgId}, 'system', 'test.tampered_for_export', 1, ${'deadbeef'.repeat(8)}, '{}'::jsonb)
      `)
    )
    const triggerRes = await callExport(app, owner.cookies, { from, to, format: 'csv' })
    const jobId = triggerRes.json<{ data: { jobId: string } }>().data.jobId

    await runAuditExport({ exportId: jobId, orgId: owner.orgId })

    const statusRes = await callStatus(app, owner.cookies, jobId)
    const statusBody = statusRes.json<{
      data: { status: string; errorReason: string; integritySummary: { failedCount: number } }
    }>().data
    expect(statusBody.status).toBe('failed')
    expect(statusBody.errorReason).toBe('integrity_check_failed')
    expect(statusBody.integritySummary.failedCount).toBeGreaterThan(0)

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(auditExports).where(eq(auditExports.id, jobId))
    )
    expect(row?.fileContent).toBeNull()

    const downloadRes = await callDownload(app, owner.cookies, jobId)
    expect(downloadRes.statusCode).toBe(404)
  }, 20_000)

  it('verifies a row whose created_at lands exactly on the requested `to` boundary (AC-10/11 boundary regression)', async () => {
    // fetchExportRows (this file, export.ts) is inclusive of `to` (`lte`), but Story 8.1's
    // verifyAuditRange() treats `to` as exclusive (`lt`). A row landing exactly on the boundary
    // must still be integrity-checked before it can appear in the export — otherwise a tampered
    // boundary row would silently ship in the CSV while the job reports a clean "all verified"
    // result, defeating AC-11's fail-closed guarantee.
    const owner = await registerOwner(app, 'export-boundary')
    const to = new Date(Date.now() + 3_600_000)
    const from = new Date(Date.now() - 3_600_000)
    // Self-inconsistent HMAC (same technique as the AC-11 test above), created_at pinned to
    // exactly the export's `to` boundary.
    await withOrg(owner.orgId, (tx) =>
      tx.execute(sql`
        INSERT INTO audit_log_entries (org_id, actor_type, event_type, key_version, hmac, payload, created_at)
        VALUES (${owner.orgId}, 'system', 'test.tampered_at_boundary', 1, ${'deadbeef'.repeat(8)}, '{}'::jsonb, ${to.toISOString()}::timestamptz)
      `)
    )

    const triggerRes = await callExport(app, owner.cookies, {
      from: from.toISOString(),
      to: to.toISOString(),
      format: 'csv',
    })
    const jobId = triggerRes.json<{ data: { jobId: string } }>().data.jobId

    await runAuditExport({ exportId: jobId, orgId: owner.orgId })

    const statusRes = await callStatus(app, owner.cookies, jobId)
    const statusBody = statusRes.json<{
      data: { status: string; errorReason: string; integritySummary: { failedCount: number } }
    }>().data
    // If the boundary row were silently skipped by verification, this would incorrectly read
    // "completed" with failedCount 0 while still exporting the tampered row.
    expect(statusBody.status).toBe('failed')
    expect(statusBody.errorReason).toBe('integrity_check_failed')
    expect(statusBody.integritySummary.failedCount).toBeGreaterThan(0)

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(auditExports).where(eq(auditExports.id, jobId))
    )
    expect(row?.fileContent).toBeNull()
  }, 20_000)

  it('returns 404 for an unknown jobId and for cross-org access (AC-15)', async () => {
    const ownerA = await registerOwner(app, 'export-status-a')
    const ownerB = await registerOwner(app, 'export-status-b')
    const { from, to } = wideRange()
    const triggerRes = await callExport(app, ownerA.cookies, { from, to, format: 'csv' })
    const jobId = triggerRes.json<{ data: { jobId: string } }>().data.jobId

    const unknown = await callStatus(app, ownerA.cookies, randomUUID())
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ code: 'export_not_found' })

    const crossOrg = await callStatus(app, ownerB.cookies, jobId)
    expect(crossOrg.statusCode).toBe(404)
    expect(crossOrg.json()).toMatchObject({ code: 'export_not_found' })
  })

  it('reports "processing" shape (no integritySummary/downloadUrl) before the worker runs (AC-15)', async () => {
    const owner = await registerOwner(app, 'export-processing')
    const { from, to } = wideRange()
    const triggerRes = await callExport(app, owner.cookies, { from, to, format: 'csv' })
    const jobId = triggerRes.json<{ data: { jobId: string } }>().data.jobId

    const statusRes = await callStatus(app, owner.cookies, jobId)
    const body = statusRes.json<{ data: { status: string; downloadUrl: string | null } }>().data
    expect(body.status).toBe('pending')
    expect(body.downloadUrl).toBeNull()
  })

  it('processes two overlapping export requests independently (AC-16)', async () => {
    const owner = await registerOwner(app, 'export-concurrency')
    const { from, to } = wideRange()

    const [res1, res2] = await Promise.all([
      callExport(app, owner.cookies, { from, to, format: 'csv' }),
      callExport(app, owner.cookies, { from, to, format: 'csv' }),
    ])
    const jobId1 = res1.json<{ data: { jobId: string } }>().data.jobId
    const jobId2 = res2.json<{ data: { jobId: string } }>().data.jobId
    expect(jobId1).not.toBe(jobId2)

    await Promise.all([
      runAuditExport({ exportId: jobId1, orgId: owner.orgId }),
      runAuditExport({ exportId: jobId2, orgId: owner.orgId }),
    ])

    const [status1, status2] = await Promise.all([
      callStatus(app, owner.cookies, jobId1),
      callStatus(app, owner.cookies, jobId2),
    ])
    expect(status1.json<{ data: { status: string } }>().data.status).toBe('completed')
    expect(status2.json<{ data: { status: string } }>().data.status).toBe('completed')
  }, 20_000)

  it('chunks verification across sub-ranges for a >90-day export (AC-10)', async () => {
    const owner = await registerOwner(app, 'export-chunked')
    const from = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
    const to = new Date()
    // Sanity: the span itself exceeds a single verify() call's own range cap, proving chunking
    // is required for this worker to succeed at all.
    expect((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)).toBeGreaterThan(
      AUDIT_VERIFY_MAX_RANGE_DAYS
    )

    const triggerRes = await callExport(app, owner.cookies, {
      from: from.toISOString(),
      to: to.toISOString(),
      format: 'csv',
    })
    const jobId = triggerRes.json<{ data: { jobId: string } }>().data.jobId

    await runAuditExport({ exportId: jobId, orgId: owner.orgId })

    const statusRes = await callStatus(app, owner.cookies, jobId)
    expect(statusRes.json<{ data: { status: string } }>().data.status).toBe('completed')
  }, 30_000)
})
