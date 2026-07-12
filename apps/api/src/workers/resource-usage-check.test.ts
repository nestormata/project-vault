import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { adminAlerts, orgMemberships, systemSettings } from '@project-vault/db/schema'
import { createTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import { runResourceUsageCheck } from './resource-usage-check.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['ADMIN_DATABASE_URL'] ??= 'postgresql://postgres:password@localhost:5432/project_vault'

const ORGS_NEAR_LIMIT_ALERT_TYPE = 'resource.orgs_near_limit'
const USERS_NEAR_LIMIT_ALERT_TYPE = 'resource.users_near_limit'

function fakeBoss() {
  return { send: vi.fn(async () => 'job-id'), isStarted: () => true } as unknown as Parameters<
    typeof runResourceUsageCheck
  >[0]
}

// Story 10.4 branch coverage: a real logger double instead of `undefined`, so this worker's
// logger-gated operational-log branches actually execute.
function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

async function setMaxUsersPerOrg(value: number): Promise<void> {
  await getDb()
    .insert(systemSettings)
    .values({ id: 1, maxUsersPerOrg: value })
    .onConflictDoUpdate({ target: systemSettings.id, set: { maxUsersPerOrg: value } })
}

/** Seeds `count` active members for `orgId` (the first as 'owner' so per-org notification
 * routing — which defaults to the 'owner' role, Story 3.2 — has somewhere to deliver to; the
 * rest as 'member') in their own committed transactions — the check job reads via a separate
 * (admin) connection, so the membership inserts must actually commit before
 * `runResourceUsageCheck` runs, not still be in-flight inside an outer withTestOrg() callback. */
async function seedActiveMembers(orgId: string, count: number, label: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const userId = await createTestUser(`${label}-${i}`)
    const role = i === 0 ? 'owner' : 'member'
    await withOrg(orgId, (tx) =>
      tx.insert(orgMemberships).values({ orgId, userId, role, status: 'active' })
    )
  }
}

describe.sequential('Story 9.2 AC-13/AC-14: resource-usage-check worker', () => {
  afterEach(async () => {
    await getDb().delete(systemSettings)
  })

  // Hygiene: this file's own tests intentionally leave 'resource.orgs_near_limit'/
  // 'resource.users_near_limit' active rows to assert on — clear them so they don't leak into
  // other test files sharing this database (same discipline as audit-storage-check.test.ts).
  afterAll(async () => {
    await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, ORGS_NEAR_LIMIT_ALERT_TYPE))
    await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, USERS_NEAR_LIMIT_ALERT_TYPE))
  })

  it('AC-13: fires a per-org users_near_limit alert at 80% and delivers to that org', async () => {
    await setMaxUsersPerOrg(5)
    await withTestOrg(async ({ orgId }) => {
      await getDb()
        .delete(adminAlerts)
        .where(eq(adminAlerts.alertType, USERS_NEAR_LIMIT_ALERT_TYPE))
      // 4 active members / limit 5 = 80%.
      await seedActiveMembers(orgId, 4, 'resource-usage-user')

      const boss = fakeBoss()
      await runResourceUsageCheck(boss, fakeLogger())

      const rows = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.alertType, USERS_NEAR_LIMIT_ALERT_TYPE))
      const forThisOrg = rows.find((r) => (r.payload as { scopeKey?: string }).scopeKey === orgId)
      expect(forThisOrg?.status).toBe('active')
      expect((forThisOrg?.payload as { thresholdPct: number }).thresholdPct).toBe(80)
      expect(boss.send).toHaveBeenCalled()
    })
  })

  it('AC-13 idempotency: a second consecutive check at the same level does not re-fire', async () => {
    await setMaxUsersPerOrg(5)
    await withTestOrg(async ({ orgId }) => {
      await getDb()
        .delete(adminAlerts)
        .where(eq(adminAlerts.alertType, USERS_NEAR_LIMIT_ALERT_TYPE))
      await seedActiveMembers(orgId, 4, 'resource-usage-idem')

      await runResourceUsageCheck(fakeBoss(), fakeLogger())
      await runResourceUsageCheck(fakeBoss(), fakeLogger())

      const rows = await getDb()
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.alertType, USERS_NEAR_LIMIT_ALERT_TYPE))
      const forThisOrg = rows.filter(
        (r) => (r.payload as { scopeKey?: string }).scopeKey === orgId && r.status === 'active'
      )
      expect(forThisOrg).toHaveLength(1)
    })
  })

  it('AC-14: fires an instance-wide orgs_near_limit alert (admin_alerts only, no per-org delivery)', async () => {
    await getDb().delete(adminAlerts).where(eq(adminAlerts.alertType, ORGS_NEAR_LIMIT_ALERT_TYPE))
    const [orgCountRow] = await getDb().execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM organizations`
    )
    const currentOrgCount = Number(orgCountRow?.c ?? 0)
    // Set the limit just below the current count so the instance is already >= 95%.
    await setMaxUsersPerOrg(50)
    await getDb()
      .update(systemSettings)
      .set({ maxOrgs: Math.max(1, currentOrgCount - 1) })
      .where(eq(systemSettings.id, 1))

    await runResourceUsageCheck(fakeBoss(), fakeLogger())

    const [row] = await getDb()
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, ORGS_NEAR_LIMIT_ALERT_TYPE))
    expect(row?.status).toBe('active')
  })
})
