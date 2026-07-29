import type { FastifyRequest } from 'fastify'
import type { SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'

/** Shared by routes.ts (creation/revocation) and access-routes.ts (reveal) — every
 *  credential_share audit write uses this same shape, in the same DB transaction as the
 *  mutation it records (route-audit.test.ts's sameTransactionAuditService check for
 *  writeShareAuditEntry resolves against the call site in each file, not this definition). */
export function writeShareAuditEntry(
  tx: SecureRouteContext['tx'],
  auth: SecureRouteContext['auth'],
  req: FastifyRequest,
  input: { eventType: string; resourceId: string; payload: Record<string, unknown> }
): Promise<void> {
  return writeHumanAuditEntryOrFailClosed(tx, {
    orgId: auth.orgId,
    actorUserId: auth.userId,
    resourceType: 'credential_share',
    request: req,
    ...input,
  })
}
