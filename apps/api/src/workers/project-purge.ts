import { eq } from 'drizzle-orm'
import { OperationalEvent, AuditEvent } from '@project-vault/shared'
import { projects } from '@project-vault/db/schema'
import { forEachSequential } from '../lib/for-each-sequential.js'
import { writeSystemAuditEntryOrFailClosed } from '../lib/audit-or-fail-closed.js'
import { operationalLog, serializeLogError } from '../lib/logger.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { eraseProjectData, findPurgeDueProjectIds } from '../modules/projects/project-lifecycle.js'
import type { WorkerLogger } from './expiry-alert-shared.js'

export const PROJECT_PURGE_JOB = 'projects/purge-deleted'
const JOB_NAME = PROJECT_PURGE_JOB

/**
 * Story 72-9: purges soft-deleted projects whose grace period has ended. One transaction per
 * organization to find the due ids, then ONE transaction per project (RLS bound to its org) that
 * locks the row, deletes the project's data (credentials with their versions and shares,
 * rotations, machine users, monitoring records, invitations, memberships...), turns the row into a
 * tombstone and writes the `project.purged` audit row. The erase and the audit row commit or roll
 * back together, so a purge never happens unaudited. The audit log is kept untouched.
 */
async function purgeOne(orgId: string, projectId: string, now: Date): Promise<boolean> {
  return runOrgScopedJob(orgId, JOB_NAME, async ({ tx }) => {
    const [row] = await tx
      .select({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    if (!row) return false
    // The audit row names the project BEFORE it is blanked; both commit or roll back together.
    const erased = await eraseProjectData(tx, projectId, now)
    if (!erased) return false
    await writeSystemAuditEntryOrFailClosed(tx, {
      orgId,
      eventType: AuditEvent.PROJECT_PURGED,
      resourceId: row.id,
      resourceType: 'project',
      payload: { projectId: row.id, name: row.name, slug: row.slug },
    })
    return true
  })
}

async function purgeOrg(orgId: string, now: Date, logger?: WorkerLogger): Promise<number> {
  const dueIds = await runOrgScopedJob(orgId, JOB_NAME, ({ tx }) => findPurgeDueProjectIds(tx, now))
  let purged = 0
  await forEachSequential(dueIds, async (projectId) => {
    try {
      if (await purgeOne(orgId, projectId, now)) purged += 1
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.PROJECT_PURGE_ROW_FAILED,
          'Project purge failed for one project — skipping and continuing',
          { orgId, projectId, err: serializeLogError(error) }
        )
      }
    }
  })
  return purged
}

/** `projects/purge-deleted` — pg-boss job on an hourly cron (apps/api/src/main.ts). */
export async function runProjectPurgeJob(logger?: WorkerLogger, now = new Date()): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  let total = 0
  await forEachSequential(orgIds, async (orgId) => {
    try {
      total += await purgeOrg(orgId, now, logger)
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.PROJECT_PURGE_ROW_FAILED,
          'Project purge failed for one org — skipping and continuing',
          { orgId, err: serializeLogError(error) }
        )
      }
    }
  })
  if (logger) {
    operationalLog(
      logger,
      'info',
      OperationalEvent.PROJECT_PURGE_RUN,
      'projects:purge-deleted completed',
      {
        purgedCount: total,
      }
    )
  }
}
