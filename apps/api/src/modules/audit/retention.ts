import { eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditRetentionConfig } from '@project-vault/db/schema'

/** D7 — no tier/subscription concept exists anywhere in this codebase yet; these are a
 * platform-wide sane bound, not a per-tier ceiling. */
export const AUDIT_RETENTION_MIN_DAYS = 30
export const AUDIT_RETENTION_MAX_DAYS = 3650

export class RetentionDaysOutOfBoundsError extends Error {}

export type ConfigureRetentionResult = {
  retentionDays: number | null
  updatedAt: string
}

/** AC-22 — upserts the org's retention config (one row per org). `retentionDays: null` is a
 * valid, explicit "retain forever" state. */
export async function configureRetention(
  tx: Tx,
  orgId: string,
  retentionDays: number | null
): Promise<ConfigureRetentionResult> {
  if (
    retentionDays !== null &&
    (retentionDays < AUDIT_RETENTION_MIN_DAYS || retentionDays > AUDIT_RETENTION_MAX_DAYS)
  ) {
    throw new RetentionDaysOutOfBoundsError(
      `retentionDays must be null or between ${AUDIT_RETENTION_MIN_DAYS} and ${AUDIT_RETENTION_MAX_DAYS}`
    )
  }
  const updatedAt = new Date()
  await tx
    .insert(auditRetentionConfig)
    .values({ orgId, retentionDays, updatedAt })
    .onConflictDoUpdate({
      target: auditRetentionConfig.orgId,
      set: { retentionDays, updatedAt },
    })
  return { retentionDays, updatedAt: updatedAt.toISOString() }
}

export async function getRetentionConfig(
  tx: Tx,
  orgId: string
): Promise<{ retentionDays: number | null } | null> {
  const [row] = await tx
    .select({ retentionDays: auditRetentionConfig.retentionDays })
    .from(auditRetentionConfig)
    .where(eq(auditRetentionConfig.orgId, orgId))
    .limit(1)
  return row ?? null
}
