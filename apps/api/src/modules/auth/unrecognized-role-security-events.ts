import { createHmac } from 'node:crypto'
import { getDb, type Tx } from '@project-vault/db'
import { platformSecurityEvents } from '@project-vault/db/schema'
import { RoleSecurityEvent } from '@project-vault/shared'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { getAuditKey } from '../vault/key-service.js'

export type UnrecognizedRoleSource = 'requested' | 'stored'

export type UnrecognizedRoleSecurityEventFields = {
  source: UnrecognizedRoleSource
  role: string
  orgId?: string
  userId?: string
  routeKey?: string
  requestId?: string
  ipAddress?: string | null
  userAgent?: string | null
}

function subjectHash(value: string): string {
  return createHmac('sha256', getAuditKey()).update(value).digest('hex')
}

function payloadOf(fields: UnrecognizedRoleSecurityEventFields): Record<string, unknown> {
  return {
    source: fields.source,
    role: fields.role,
    ...(fields.orgId === undefined ? {} : { orgId: fields.orgId }),
    ...(fields.routeKey === undefined ? {} : { routeKey: fields.routeKey }),
    ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
  }
}

/**
 * Story 73.5 D7: unknown requested or stored role. Rows go to platform_security_events (no RLS,
 * no org_id). Best effort: a write failure never changes the HTTP response.
 */
export async function writeUnrecognizedRoleSecurityEvent(
  fields: UnrecognizedRoleSecurityEventFields
): Promise<void> {
  try {
    const payload = payloadOf(fields)
    const hashedSubject = fields.userId ? subjectHash(fields.userId) : null
    await getDb().transaction(async (tx) => {
      const keyVersion = await currentAuditKeyVersion(tx as Tx)
      const eventType = RoleSecurityEvent.UNRECOGNIZED_ROLE
      const hmac = computeAuditHmac(
        { eventType, subjectHash: hashedSubject, emailDomain: null, payload, keyVersion },
        getAuditKey()
      )
      await (tx as Tx).insert(platformSecurityEvents).values({
        eventType,
        subjectHash: hashedSubject,
        emailDomain: null,
        payload,
        keyVersion,
        hmac,
        ipAddress: fields.ipAddress ?? null,
        userAgent: fields.userAgent ?? null,
      })
    })
  } catch (error) {
    process.stderr.write(
      `[role.security_event_write_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}
