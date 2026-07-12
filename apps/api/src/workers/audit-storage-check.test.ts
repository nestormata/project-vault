import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['ADMIN_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'
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

  it('AC-17: resumes normal operation — utilization dropping back below 95% clears maintenance mode and a routine write succeeds again', async () => {
    const { shouldSuppressAuditWrite } = await import('../modules/audit/maintenance-mode.js')
    const { withTestOrg } = await import('@project-vault/db/test-helpers')

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

    await withTestOrg(async ({ tx }) => {
      expect(await shouldSuppressAuditWrite(tx, 'credential.value_revealed')).toBe(false)
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
