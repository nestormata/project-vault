import { createHmac } from 'node:crypto'
import { getDb, type Tx } from '@project-vault/db'
import { platformSecurityEvents } from '@project-vault/db/schema'
import type { HandoffEventType } from '@project-vault/shared'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { getAuditKey } from '../vault/key-service.js'
import type { RequestMeta } from './service.js'

/**
 * Story 30.2 AC6.23: every `handoff_*` rejection occurring before org resolution (rejection-matrix
 * rows 1-8) is written here — the no-RLS, no-`org_id` `platform_security_events` table, mirroring
 * `sso-routes.ts`'s `writePlatformSsoRejected()` precedent exactly. This is the SINGLE write path
 * for every pre-org handoff event, which is also what makes AC6.22's redaction coverage provable
 * with one shared test: `payload` here is always a small, fixed-shape object built from
 * already-validated/typed fields — the raw compact JWS string is a function PARAMETER type this
 * module's signature makes structurally impossible to pass through (there is no `token: string`
 * field anywhere in `HandoffSecurityEventFields`).
 */
export type HandoffSecurityEventFields = {
  eventType: HandoffEventType
  subject?: string
  meta: RequestMeta
  payload?: Record<string, unknown>
}

function subjectHash(value: string): string {
  return createHmac('sha256', getAuditKey()).update(value).digest('hex')
}

/** Defense-in-depth: strip a `token`/`rawToken` key even if a future caller mistakenly includes
 *  one in `payload` — belt-and-suspenders alongside the type shape's structural prevention. */
function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const {
    token: _token,
    rawToken: _rawToken,
    ...rest
  } = payload as Record<string, unknown> & {
    token?: unknown
    rawToken?: unknown
  }
  return rest
}

export async function writeHandoffSecurityEvent(fields: HandoffSecurityEventFields): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      const keyVersion = await currentAuditKeyVersion(tx as Tx)
      const eventType = fields.eventType
      const payload = sanitizePayload(fields.payload ?? {})
      const hashedSubject = fields.subject ? subjectHash(fields.subject) : null
      const hmac = computeAuditHmac(
        {
          eventType,
          subjectHash: hashedSubject,
          emailDomain: null,
          payload,
          keyVersion,
        },
        getAuditKey()
      )
      await (tx as Tx).insert(platformSecurityEvents).values({
        eventType,
        subjectHash: hashedSubject,
        emailDomain: null,
        payload,
        keyVersion,
        hmac,
        ipAddress: fields.meta.ipAddress ?? null,
        userAgent: fields.meta.userAgent ?? null,
      })
    })
  } catch (error) {
    process.stderr.write(
      `[handoff.security_event_write_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}
