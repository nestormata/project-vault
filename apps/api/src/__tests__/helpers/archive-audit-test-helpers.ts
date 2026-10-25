import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, userIdentityTokens } from '@project-vault/db/schema'

/** Story 69.20: the archive audit rows for one resource, with the actor resolved to its user id. */
export async function archiveAuditRowsFor(
  orgId: string,
  eventType: string,
  resourceId: string
): Promise<{ actorUserId: string | null; payload: unknown }[]> {
  return withOrg(orgId, (tx) =>
    tx
      .select({ actorUserId: userIdentityTokens.userId, payload: auditLogEntries.payload })
      .from(auditLogEntries)
      .leftJoin(userIdentityTokens, eq(userIdentityTokens.id, auditLogEntries.actorTokenId))
      .where(
        and(eq(auditLogEntries.eventType, eventType), eq(auditLogEntries.resourceId, resourceId))
      )
  )
}
