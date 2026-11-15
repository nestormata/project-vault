import { createHmac } from 'node:crypto'
import { IdentityRevocationEvent } from '@project-vault/shared'
import { getAuditKey } from '../vault/key-service.js'
import { writePlatformSecurityEventBestEffort } from './platform-security-event-write.js'

export function hashIdentityRevocationSubject(iss: string, sub: string): string {
  return createHmac('sha256', getAuditKey()).update(`${iss}:${sub}`).digest('hex')
}

type IdentityRevocationSecurityEventFields = {
  eventType: (typeof IdentityRevocationEvent)[keyof typeof IdentityRevocationEvent]
  subjectHash?: string | null
  payload: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const {
    token: _token,
    rawToken: _rawToken,
    sub: _sub,
    ...rest
  } = payload as Record<string, unknown> & { token?: unknown; rawToken?: unknown; sub?: unknown }
  return rest
}

export async function writeIdentityRevocationSecurityEvent(
  fields: IdentityRevocationSecurityEventFields
): Promise<void> {
  await writePlatformSecurityEventBestEffort({
    eventType: fields.eventType,
    subjectHash: fields.subjectHash ?? null,
    payload: sanitizePayload(fields.payload),
    ipAddress: fields.ipAddress,
    userAgent: fields.userAgent,
    logLabel: 'identity_revocation.security_event_write_error',
  })
}
