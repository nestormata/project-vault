import { and, eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { adminAlerts } from '@project-vault/db/schema'
import type { NotificationSeverity } from '@project-vault/shared'
import type { BossService } from '../../lib/boss.js'
import { fetchAllOrgIds } from '../../middleware/rls.js'
import {
  createOrgAdminNotificationEntries,
  sendNotificationJobs,
} from '../../notifications/dispatcher.js'

/**
 * Story 9.1 D3/AC-12: idempotent admin_alerts creation — an advisory lock keyed by alertType
 * makes the "is one already active" check + insert atomic, same discipline as
 * createMonitoringAlertIfNotDeduped's per-episode dedup (Story 6.2). Returns null (no insert) if
 * an alert of this type is already active — the caller must not deliver a duplicate notification.
 */
export async function createAdminAlertIfNotActive(input: {
  alertType: string
  severity: 'info' | 'warning' | 'critical'
  payload: Record<string, unknown>
}): Promise<{ id: string } | null> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.alertType}))`)
    const [existing] = await tx
      .select({ id: adminAlerts.id })
      .from(adminAlerts)
      .where(and(eq(adminAlerts.alertType, input.alertType), eq(adminAlerts.status, 'active')))
      .limit(1)
    if (existing) return null

    const [row] = await tx
      .insert(adminAlerts)
      .values({ alertType: input.alertType, severity: input.severity, payload: input.payload })
      .returning({ id: adminAlerts.id })
    return row ?? null
  })
}

/**
 * Story 9.1 AC-13: `backup.failure` alerts are NEVER deduped against an existing active one —
 * unlike `backup.missed` (AC-12), each failure is a distinct event worth its own record for the
 * audit trail (three consecutive nightly failures create three rows, not one). Delivery-side
 * spam is handled by the existing notification-preferences digest/dedup logic (Story 3.2), not
 * by suppressing the row here.
 */
export async function createAdminAlert(input: {
  alertType: string
  severity: 'info' | 'warning' | 'critical'
  payload: Record<string, unknown>
}): Promise<{ id: string }> {
  const [row] = await getDb()
    .insert(adminAlerts)
    .values({ alertType: input.alertType, severity: input.severity, payload: input.payload })
    .returning({ id: adminAlerts.id })
  if (!row) throw new Error('createAdminAlert: insert returned no row')
  return row
}

/**
 * Story 9.1 D7: `resolveRoutingRecipients` is org-scoped, but backup health alerts affect every
 * org on the instance (backup is whole-instance, D2) — loops every org and delivers to the union
 * of resolved recipients. In the common single-org self-hosted deployment (the vast majority of
 * v1 installs) this loop runs exactly once, so there's no behavior change for the typical case.
 */
export async function deliverAdminAlertAcrossOrgs(
  boss: BossService,
  alertType: string,
  payload: Record<string, unknown>,
  severity: NotificationSeverity = 'critical'
): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  const allJobs = []
  for (const orgId of orgIds) {
    const jobs = await withOrg(orgId, (tx) =>
      createOrgAdminNotificationEntries({
        orgId,
        tx,
        template: { templateId: alertType, severity, payload },
      })
    )
    allJobs.push(...jobs)
  }
  await sendNotificationJobs(boss, allJobs)
}
