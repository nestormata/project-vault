import { createHmac } from 'node:crypto'
import { RoleSecurityEvent } from '@project-vault/shared'
import { getAuditKey } from '../vault/key-service.js'
import { writePlatformSecurityEventBestEffort } from './platform-security-event-write.js'

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
  await writePlatformSecurityEventBestEffort({
    eventType: RoleSecurityEvent.UNRECOGNIZED_ROLE,
    subjectHash: fields.userId ? subjectHash(fields.userId) : null,
    payload: payloadOf(fields),
    ipAddress: fields.ipAddress,
    userAgent: fields.userAgent,
    logLabel: 'role.security_event_write_error',
  })
}
