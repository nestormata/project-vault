import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { cliDeviceGrants } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { forEachSequential } from '../../lib/for-each-sequential.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'

/** Story 43.30: an unconsumed approval dies with the browser session that approved it. */
export async function revokeDeviceGrantsForSessions(
  tx: Tx,
  sessionIds: readonly string[],
  now = new Date()
): Promise<void> {
  if (sessionIds.length === 0) return
  const revoked = await tx
    .update(cliDeviceGrants)
    .set({ status: 'revoked', revokedAt: now })
    .where(
      and(
        inArray(cliDeviceGrants.approverSessionId, [...sessionIds]),
        eq(cliDeviceGrants.status, 'approved'),
        isNull(cliDeviceGrants.consumedAt)
      )
    )
    .returning({
      id: cliDeviceGrants.id,
      orgId: cliDeviceGrants.orgId,
      userId: cliDeviceGrants.userId,
    })
  await forEachSequential(revoked, async (grant) => {
    if (!grant.orgId || !grant.userId) return
    await writeHumanAuditEntry(tx, {
      orgId: grant.orgId,
      actorTokenId: await firstActorTokenIdForUser(tx, grant.userId),
      eventType: AuditEvent.CLI_DEVICE_LOGIN_REVOKED,
      payload: { grantId: grant.id },
    })
  })
}
