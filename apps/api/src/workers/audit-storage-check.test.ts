import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['ADMIN_DATABASE_URL'] ??= 'postgresql://vault_admin@admin-db.invalid:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
// Tiny limit (bytes, expressed in GB) so the real (already non-empty) audit_log_entries table
// comfortably exceeds 95% utilization without needing to seed millions of rows.
process.env['AUDIT_LOG_STORAGE_LIMIT_GB'] = '0.000001'
// Story 9.4 AC-18: same "tiny limit forces >=95% against the already-non-empty table" trick,
// independent threshold for the new platform_audit_events table.
process.env['PLATFORM_AUDIT_STORAGE_LIMIT_GB'] = '0.000001'

const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { adminAlerts } = await import('@project-vault/db/schema')
const { eq } = await import('drizzle-orm')
const { runAuditStorageCheck } = await import('./audit-storage-check.js')

function fakeBoss() {
  return { send: vi.fn(async () => 'job-id'), isStarted: () => true } as unknown as Parameters<
    typeof runAuditStorageCheck
  >[0]
}

// Story 10.4 branch coverage: a real logger double (matching this repo's job-logging.test.ts/
// shutdown.test.ts precedent) instead of `undefined`, so the `logger &&`-gated operational-log
// branches inside audit-storage-check.ts (warning/critical/healthy-transition messages) actually
// execute instead of short-circuiting.
function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const CRITICAL_ALERT_TYPE = 'audit_storage.critical'
const WARNING_ALERT_TYPE = 'audit_storage.warning'

async function clearAuditStorageAlerts(): Promise<void> {
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, CRITICAL_ALERT_TYPE))
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, WARNING_ALERT_TYPE))
}

describe.sequential('Story 9.2 D5/AC-15 through AC-17: audit-storage-check worker', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    try {
      await initVault({ kmsType: 'passphrase', passphrase: 'audit-storage-check-test' }, {})
    } catch (error) {
      if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    }
  })

  // Critical: an active `audit_storage.critical` row IS the maintenance-mode flag (D10/AC-17) —
  // every audit write anywhere in the app (this is a shared test database across the whole
  // suite) checks it. Leaving one active after this file's tests finish would silently suppress
  // routine audit writes in every *other* test file that happens to run afterward.
  afterAll(async () => {
    await clearAuditStorageAlerts()
  })

  it("D5 regression guard: the job queries the real table name, not epics.md's literal (wrong) one", () => {
    const source = readFileSync(new URL('./audit-storage-check.ts', import.meta.url), 'utf8')
    expect(source).toContain("pg_total_relation_size('audit_log_entries')")
    expect(source).not.toContain("pg_total_relation_size('audit_events')")
  })

  it('AC-16/AC-17: creates a critical alert (maintenance mode) at >=95% utilization and delivers it', async () => {
    await clearAuditStorageAlerts()
    const boss = fakeBoss()
    await runAuditStorageCheck(boss, fakeLogger())

    const [critical] = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, CRITICAL_ALERT_TYPE))
    expect(critical?.status).toBe('active')
    expect(critical?.severity).toBe('critical')
    expect(boss.send).toHaveBeenCalled()
  })

  it('AC-16: idempotent — a second consecutive check does not create a duplicate active critical alert', async () => {
    const boss = fakeBoss()
    await runAuditStorageCheck(boss, fakeLogger())
    const activeCritical = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, CRITICAL_ALERT_TYPE))
    expect(activeCritical.filter((r) => r.status === 'active')).toHaveLength(1)
  })

  it('AC-17: fails safe — a job error (e.g. delivery failure) is thrown and surfaced, not swallowed', async () => {
    await clearAuditStorageAlerts()
    const boss = {
      send: vi.fn(async () => {
        throw new Error('boom')
      }),
      isStarted: () => true,
    } as unknown as Parameters<typeof runAuditStorageCheck>[0]
    await expect(runAuditStorageCheck(boss, fakeLogger())).rejects.toThrow()
  })

  it('AC-17/Story 22.1 AC-10/AC-12: resumes normal operation — utilization dropping back below 95% clears the (now alert-only) audit_storage.critical episode, and a routine write was never suppressed by it in the first place (the instance-wide write gate is deleted)', async () => {
    const { writeHumanAuditEntry } = await import('../modules/audit/human-entry.js')
    const { auditLogEntries } = await import('@project-vault/db/schema')
    const { withTestOrg, createTestUser } = await import('@project-vault/db/test-helpers')
    const { firstActorTokenIdForUser } = await import('../modules/audit/actor-token.js')

    // Seed maintenance mode as already active (simulating the prior day's critical check), then
    // run the check with a deliberately huge limit override so this call computes healthy
    // utilization regardless of the file-wide tiny AUDIT_LOG_STORAGE_LIMIT_GB (real production
    // call sites never pass this override — see computeUtilization()'s doc comment).
    await getDb().insert(adminAlerts).values({
      alertType: CRITICAL_ALERT_TYPE,
      severity: 'critical',
      payload: {},
      status: 'active',
    })

    const healthyLogger = fakeLogger()
    await runAuditStorageCheck(fakeBoss(), healthyLogger, 999_999)

    const [critical] = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, CRITICAL_ALERT_TYPE))
    expect(critical?.status).toBe('acknowledged')
    // The wasActive-and-now-healthy transition logs a distinct maintenance-mode-exited warning.
    expect(healthyLogger.warn).toHaveBeenCalled()

    // Story 22.1 AC-12's headline regression fix: even while the critical alert was active above,
    // a routine (non-security-critical) write was never suppressed — the instance-wide
    // maintenance-mode write gate no longer exists, so this now writes and succeeds unconditionally.
    await withTestOrg(async ({ orgId, tx }) => {
      const userId = await createTestUser('audit-storage-check-routine-actor')
      const actorTokenId = await firstActorTokenIdForUser(tx, userId)
      await writeHumanAuditEntry(tx, {
        orgId,
        actorTokenId,
        eventType: 'credential.value_revealed',
        payload: {},
      })
      const rows = await tx
        .select({ id: auditLogEntries.id })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.value_revealed'))
      expect(rows.length).toBeGreaterThanOrEqual(1)
    })
  })
})

const PLATFORM_CRITICAL_ALERT_TYPE = 'platform_audit_storage.critical'
const PLATFORM_WARNING_ALERT_TYPE = 'platform_audit_storage.warning'

async function clearPlatformAuditStorageAlerts(): Promise<void> {
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, PLATFORM_CRITICAL_ALERT_TYPE))
  await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, PLATFORM_WARNING_ALERT_TYPE))
}

describe.sequential(
  'Story 9.4 AC-18/D10: audit-storage-check extension for platform_audit_events',
  () => {
    // Bug found via full-suite regression run: these tests call runAuditStorageCheck() without a
    // limitGbOverride, so the ORG-SCOPED check also runs against this file's persistently-tiny
    // AUDIT_LOG_STORAGE_LIMIT_GB, creating a fresh audit_storage.critical row as a side effect —
    // clearing only the platform-scoped alert types here left that row active for the rest of the
    // suite (the exact "leaves maintenance mode on for every later file" risk the comment above
    // this file's original afterAll already warns about).
    afterAll(async () => {
      await clearAuditStorageAlerts()
      await clearPlatformAuditStorageAlerts()
    })

    it('D10 regression guard: the job queries platform_audit_events too, independently of audit_log_entries', () => {
      const source = readFileSync(new URL('./audit-storage-check.ts', import.meta.url), 'utf8')
      expect(source).toContain("pg_total_relation_size('platform_audit_events')")
    })

    it('AC-18: raises a distinct platform_audit_storage.critical alert at >=95% utilization', async () => {
      await clearAuditStorageAlerts()
      await clearPlatformAuditStorageAlerts()
      const boss = fakeBoss()
      await runAuditStorageCheck(boss, fakeLogger())

      const [critical] = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.alertType, PLATFORM_CRITICAL_ALERT_TYPE))
      expect(critical?.status).toBe('active')
      expect(critical?.severity).toBe('critical')
    })

    it('AC-18 edge: both logs are evaluated and alerted independently — never conflated into one alert row', async () => {
      await clearAuditStorageAlerts()
      await clearPlatformAuditStorageAlerts()
      await runAuditStorageCheck(fakeBoss(), fakeLogger())

      const [orgAlert] = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.alertType, CRITICAL_ALERT_TYPE))
      const [platformAlert] = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.alertType, PLATFORM_CRITICAL_ALERT_TYPE))
      expect(orgAlert?.status).toBe('active')
      expect(platformAlert?.status).toBe('active')
    })
  }
)

describe.sequential(
  'Story 22.5 AC-6/AC-8: daily-job early-warning step for orgs already over the new default',
  () => {
    afterAll(async () => {
      await clearAuditStorageAlerts()
      await clearPlatformAuditStorageAlerts()
    })

    it('AC-6: an org with no quota-config row whose bytes_used already exceeds the resolved default is WARN-logged with its org id and both figures, and AC-8: the existing instance-wide critical alert still fires unaffected', async () => {
      const { withOrg, getDb: getRealDb } = await import('@project-vault/db')
      const { auditOrgStorageUsage } = await import('@project-vault/db/schema')
      const { withTestOrg } = await import('@project-vault/db/test-helpers')

      const previousEnforcement = process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
      const previousDefault = process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'
      // A tiny MB default so the test does not need to seed anywhere near a realistic byte count
      // to exceed it.
      process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = '1'
      vi.resetModules()
      try {
        const { runAuditStorageCheck: runWithNewDefault } = await import('./audit-storage-check.js')

        await withTestOrg(async ({ orgId }) => {
          // No audit_storage_quota_config row for this org — resolves purely via the new
          // instance-wide default (1 MB = 1_048_576 bytes here). Seed bytes_used comfortably over
          // it.
          const bytesUsed = 1_048_576 + 500
          await withOrg(orgId, (tx) =>
            tx
              .insert(auditOrgStorageUsage)
              .values({ orgId, bytesUsed, updatedAt: new Date() })
              .onConflictDoUpdate({
                target: auditOrgStorageUsage.orgId,
                set: { bytesUsed, updatedAt: new Date() },
              })
          )

          await clearAuditStorageAlerts()
          await clearPlatformAuditStorageAlerts()
          const logger = fakeLogger()
          await runWithNewDefault(fakeBoss(), logger)

          // AC-6: the WARN fired, naming this org id and both figures.
          const warnCalls = logger.warn.mock.calls
          const matchingCall = warnCalls.find(
            (call) => (call[0] as { orgId?: string })?.orgId === orgId
          )
          expect(matchingCall).toBeDefined()
          const [payload] = matchingCall as [Record<string, unknown>, string]
          expect(payload['eventType']).toBe(
            'audit_org_usage_reconcile.default_quota_already_exceeded'
          )
          expect(payload['bytesUsed']).toBe(bytesUsed)
          expect(payload['resolvedDefaultQuotaBytes']).toBe(1_048_576)

          // AC-8 regression confirmation: the existing instance-wide critical alert (this file's
          // tiny AUDIT_LOG_STORAGE_LIMIT_GB pin forces >=95% on the real, non-empty table) still
          // fires exactly as before, unaffected by this story's new early-warning step running in
          // the same job invocation.
          const [critical] = await getRealDb()
            .select()
            .from(adminAlerts)
            .where(eq(adminAlerts.alertType, CRITICAL_ALERT_TYPE))
          expect(critical?.status).toBe('active')
          expect(critical?.severity).toBe('critical')
        })
      } finally {
        if (previousEnforcement === undefined)
          delete process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
        else process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = previousEnforcement
        if (previousDefault === undefined) delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
        else process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = previousDefault
        vi.resetModules()
      }
    })

    it('AC-6 precision trap: an explicit per-org NULL quota row (operator unlimited override) is NEVER warned, even though it is also over the numeric default', async () => {
      const { withOrg } = await import('@project-vault/db')
      const { auditOrgStorageUsage, auditStorageQuotaConfig } =
        await import('@project-vault/db/schema')
      const { withTestOrg } = await import('@project-vault/db/test-helpers')

      const previousEnforcement = process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
      const previousDefault = process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
      process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = 'true'
      process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = '1'
      vi.resetModules()
      try {
        const { runAuditStorageCheck: runWithNewDefault } = await import('./audit-storage-check.js')

        await withTestOrg(async ({ orgId }) => {
          const bytesUsed = 1_048_576 + 500
          await withOrg(orgId, (tx) =>
            tx
              .insert(auditOrgStorageUsage)
              .values({ orgId, bytesUsed, updatedAt: new Date() })
              .onConflictDoUpdate({
                target: auditOrgStorageUsage.orgId,
                set: { bytesUsed, updatedAt: new Date() },
              })
          )
          // An explicit per-org NULL row — an operator's deliberate unlimited override, the TOP
          // precedence tier — must never be conflated with "no row at all".
          await withOrg(orgId, (tx) =>
            tx
              .insert(auditStorageQuotaConfig)
              .values({ orgId, quotaBytes: null, updatedAt: new Date() })
              .onConflictDoUpdate({
                target: auditStorageQuotaConfig.orgId,
                set: { quotaBytes: null, updatedAt: new Date() },
              })
          )

          await clearAuditStorageAlerts()
          await clearPlatformAuditStorageAlerts()
          const logger = fakeLogger()
          await runWithNewDefault(fakeBoss(), logger)

          const warnCalls = logger.warn.mock.calls
          const matchingCall = warnCalls.find(
            (call) => (call[0] as { orgId?: string })?.orgId === orgId
          )
          expect(matchingCall).toBeUndefined()
        })
      } finally {
        if (previousEnforcement === undefined)
          delete process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
        else process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = previousEnforcement
        if (previousDefault === undefined) delete process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB']
        else process.env['AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB'] = previousDefault
        vi.resetModules()
      }
    })
  }
)
