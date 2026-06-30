import type { FastifyRequest } from 'fastify'
import type { Tx } from '@project-vault/db'
import { firstActorTokenIdForUser } from '../modules/audit/actor-token.js'
import { writeHumanAuditEntry } from '../modules/audit/human-entry.js'
import { SameTransactionAuditWriteError } from './secure-route.js'

export type SameTransactionAuditInput = {
  orgId: string
  actorUserId: string
  eventType: string
  resourceId?: string
  resourceType: string
  payload: Record<string, unknown>
  request: FastifyRequest
}

/**
 * Writes a same-transaction human audit row and fails closed: any audit-write error is
 * rewrapped as SameTransactionAuditWriteError so SecureRoute rolls back the transaction and
 * returns 503 audit_write_failed instead of completing the mutation without an audit record.
 */
export async function writeHumanAuditEntryOrFailClosed(
  tx: Tx,
  input: SameTransactionAuditInput
): Promise<void> {
  try {
    const actorTokenId = await firstActorTokenIdForUser(tx, input.actorUserId)
    await writeHumanAuditEntry(tx, {
      orgId: input.orgId,
      actorTokenId,
      eventType: input.eventType,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      payload: input.payload,
      meta: {
        ipAddress: input.request.ip,
        userAgent:
          typeof input.request.headers['user-agent'] === 'string'
            ? input.request.headers['user-agent']
            : null,
      },
    })
  } catch (error) {
    throw new SameTransactionAuditWriteError(error instanceof Error ? error.message : String(error))
  }
}
