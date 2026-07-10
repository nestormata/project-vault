import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries, credentials } from '@project-vault/db/schema'
import type { RecentAccessEvent } from '@project-vault/shared'
import { actorDisplayNameFor, batchResolveActorDisplayNames } from '../audit/actor-display-name.js'

// AC-A4: the 8 real credential.* audit event types that satisfy AC-A1's `resource_type =
// 'credential'` query filter (see packages/shared/src/constants/audit-events.ts). Kept as a
// literal list (not imported from AuditEvent) so this query's contract stays explicit and
// reviewable independent of that broader, non-credential-specific registry.
const CREDENTIAL_RECENT_ACCESS_EVENT_TYPES = [
  'credential.created',
  'credential.version_created',
  'credential.value_revealed',
  'credential.version_purged',
  'credential.tags_updated',
  'credential.dependency_added',
  'credential.dependency_archived',
  'credential.lifecycle_updated',
] as const

/**
 * AC-A1: a project's recent credential-related audit history, sourced from `audit_log_entries`
 * filtered by `resource_type`/`resource_id`, not the unpopulated `project_id` column —
 * `writeHumanAuditEntryOrFailClosed`/`HumanAuditFields` does not thread a `projectId` through
 * today for credential events, so `audit_log_entries.project_id` is always NULL for these rows.
 * A future story should populate `project_id` on write and switch this to the indexed column
 * instead of a `resource_id IN (...)` list, which does not scale as well to very large projects.
 */
export async function getRecentAccessEventsForProject(
  tx: Tx,
  projectId: string,
  limit = 10
): Promise<RecentAccessEvent[]> {
  const credentialRows = await tx
    .select({ id: credentials.id, name: credentials.name })
    .from(credentials)
    .where(eq(credentials.projectId, projectId))

  if (credentialRows.length === 0) return []

  const credentialNameById = new Map(credentialRows.map((row) => [row.id, row.name]))
  const credentialIds = credentialRows.map((row) => row.id)

  const rows = await tx
    .select({
      resourceId: auditLogEntries.resourceId,
      actorType: auditLogEntries.actorType,
      actorTokenId: auditLogEntries.actorTokenId,
      eventType: auditLogEntries.eventType,
      createdAt: auditLogEntries.createdAt,
    })
    .from(auditLogEntries)
    .where(
      and(
        eq(auditLogEntries.resourceType, 'credential'),
        inArray(auditLogEntries.resourceId, credentialIds),
        inArray(auditLogEntries.eventType, CREDENTIAL_RECENT_ACCESS_EVENT_TYPES)
      )
    )
    .orderBy(desc(auditLogEntries.createdAt))
    .limit(limit)

  // AC-A3: reuse batchResolveActorDisplayNames/actorDisplayNameFor as-is — a pseudonymized
  // actor's token row survives with its display_name overwritten to the generated alias, so it
  // resolves correctly here with no bespoke "erased" branch needed.
  const displayNameByTokenId = await batchResolveActorDisplayNames(
    tx,
    rows.map((row) => row.actorTokenId)
  )

  return rows.map((row) => {
    const credentialId = row.resourceId as string
    return {
      credentialId,
      credentialName: credentialNameById.get(credentialId) ?? 'Unknown credential',
      actorDisplayName: actorDisplayNameFor(row.actorType, row.actorTokenId, displayNameByTokenId),
      eventType: row.eventType as RecentAccessEvent['eventType'],
      occurredAt: row.createdAt.toISOString(),
    }
  })
}
