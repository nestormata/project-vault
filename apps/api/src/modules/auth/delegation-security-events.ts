import { createHash } from 'node:crypto'
import { getDb, type Tx } from '@project-vault/db'
import { platformSecurityEvents } from '@project-vault/db/schema'
import { DelegationEvent } from '@project-vault/shared'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { getAuditKey } from '../vault/key-service.js'
import type { RequestMeta } from './service.js'

/**
 * Story 71.3 AC-8: the single write path for a rejected service-delegated actor assertion, a
 * sibling of `writeHandoffSecurityEvent`. Rows go to `platform_security_events` (no RLS, no
 * `org_id`; the resolved PV org id, when known, is in the payload) and NEVER to an org's
 * `audit_log_entries`, so a key holder cannot fill an org's audit storage with rejections.
 *
 * The input type structurally excludes the assertion, the header, the actor subject and the
 * body: only a closed reason, the route key, the resolved org id, a configured `kid`, the
 * response status and a hashed `jti` prefix can be recorded. Only a SIGNATURE-VALID assertion
 * reaches this writer (pre-signature failures are counted but write nothing, AC-2b), so an
 * unauthenticated caller cannot grow the table.
 *
 * Best effort: a write failure is swallowed to stderr (message only) and never changes the HTTP
 * response.
 */
export type DelegationSecurityEventFields = {
  /** The closed counter outcome (see `DELEGATION_OUTCOMES`). */
  reason: string
  routeKey: string
  status?: number
  orgId?: string
  /** A configured key id; never an unknown `kid` from the request. */
  kid?: string
  jti?: string
  meta: RequestMeta
}

const JTI_HASH_HEX_LENGTH = 16

/** SHA-256 of the `jti`, truncated: enough to correlate with the sender's logs, not to replay. */
export function hashedJtiPrefix(jti: string): string {
  return createHash('sha256').update(jti).digest('hex').slice(0, JTI_HASH_HEX_LENGTH)
}

function payloadOf(fields: DelegationSecurityEventFields): Record<string, unknown> {
  return {
    reason: fields.reason,
    routeKey: fields.routeKey,
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.orgId === undefined ? {} : { orgId: fields.orgId }),
    ...(fields.kid === undefined ? {} : { kid: fields.kid }),
    ...(fields.jti === undefined ? {} : { jtiHash: hashedJtiPrefix(fields.jti) }),
  }
}

export async function writeDelegationSecurityEvent(
  fields: DelegationSecurityEventFields
): Promise<void> {
  try {
    const payload = payloadOf(fields)
    await getDb().transaction(async (tx) => {
      const keyVersion = await currentAuditKeyVersion(tx as Tx)
      const eventType = DelegationEvent.DELEGATION_ASSERTION_REJECTED
      const hmac = computeAuditHmac(
        { eventType, subjectHash: null, emailDomain: null, payload, keyVersion },
        getAuditKey()
      )
      await (tx as Tx).insert(platformSecurityEvents).values({
        eventType,
        subjectHash: null,
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
      `[delegation.security_event_write_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}
