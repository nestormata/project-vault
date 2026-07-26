import type { FastifyReply } from 'fastify'
import { withOrg } from '@project-vault/db'
import { AuditEvent } from '@project-vault/shared'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { enforceUserRateLimit, parseParams, parseQuery } from '../../lib/route-helpers.js'
import { secureRoute, SameTransactionAuditWriteError } from '../../lib/secure-route.js'
import { writeMachineAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { findCredentialByNameInProject, revealCurrentValue } from '../credentials/service.js'
import { MANUAL_MACHINE_AUTH_SECURITY, verifyMachineRequest } from './machine-auth.js'
import {
  AmbiguousCredentialNameErrorSchema,
  MachineCredentialParamsSchema,
  MachineCredentialValueQuerySchema,
  MachineCredentialValueResponseSchema,
} from './machine-credential-schema.js'

const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const
const INSUFFICIENT_ROLE = {
  code: 'insufficient_role',
  message: 'Insufficient permissions',
} as const
const AUDIT_WRITE_FAILED = {
  code: 'audit_write_failed',
  message: 'Audit logging is unavailable',
} as const

const ROUTE_KEY = 'GET /api/v1/machine/projects/:projectId/credentials/:name/value'
// AC-27: 300/min per machine-JWT-implied identity (keyed by keyId, not IP) — a generous,
// CI-realistic budget, not the 60/min SecureRoute default tuned for human browsing patterns.
const OVERALL_MAX = 300
// AC-27: independently of the overall budget, failed lookups (404/409) are capped tighter —
// otherwise a stolen-but-not-yet-revoked machine JWT could use its full 300/min budget purely to
// enumerate credential names within its scoped project via repeated not-found probes.
const FAILED_LOOKUP_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60_000

function enforceOverallRateLimit(keyId: string, reply: FastifyReply): boolean {
  return enforceUserRateLimit({
    userId: `machine-key:${keyId}`,
    key: ROUTE_KEY,
    max: OVERALL_MAX,
    timeWindowMs: RATE_LIMIT_WINDOW_MS,
    reply,
  })
}

function enforceFailedLookupRateLimit(keyId: string, reply: FastifyReply): boolean {
  return enforceUserRateLimit({
    userId: `machine-key-failed:${keyId}`,
    key: `${ROUTE_KEY}:failed`,
    max: FAILED_LOOKUP_MAX,
    timeWindowMs: RATE_LIMIT_WINDOW_MS,
    reply,
  })
}

export async function machineCredentialRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/projects/:projectId/credentials/:name/value',
    schema: {
      response: {
        200: MachineCredentialValueResponseSchema,
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: AmbiguousCredentialNameErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    security: MANUAL_MACHINE_AUTH_SECURITY,
    handler: async (_ctx, req, reply) => {
      const verified = await verifyMachineRequest(req, reply)
      if (!verified) return reply

      const params = parseParams(MachineCredentialParamsSchema, req, reply)
      if (!params) return reply
      // Story 13.3 Subtask 2.6 — mirrors the human route's `?field=` support.
      const query = parseQuery(MachineCredentialValueQuerySchema, req, reply)
      if (!query) return reply
      const name = decodeURIComponent(params.name)

      if (!enforceOverallRateLimit(verified.keyId, reply)) return reply

      // AC-7: a valid machine JWT reused against a project it isn't scoped to. 403 (not 404) —
      // the caller already holds a valid, scoped credential; the project's existence isn't the
      // secret being protected here, unlike the human cross-org case.
      if (verified.projectId !== params.projectId) {
        return reply.status(403).send(INSUFFICIENT_ROLE)
      }

      try {
        return await withOrg(verified.orgId, async (tx) => {
          const matches = await findCredentialByNameInProject(tx, {
            projectId: params.projectId,
            name,
          })

          if (matches.length === 0) {
            if (!enforceFailedLookupRateLimit(verified.keyId, reply)) return reply
            return reply.status(404).send(CREDENTIAL_NOT_FOUND)
          }
          if (matches.length > 1) {
            if (!enforceFailedLookupRateLimit(verified.keyId, reply)) return reply
            return reply.status(409).send({
              code: 'ambiguous_credential_name' as const,
              message:
                'Multiple credentials share this name in this project; machine-user retrieval requires unique names',
              matchCount: matches.length,
            })
          }

          const credential = matches[0]
          if (!credential) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

          const result = await revealCurrentValue(tx, {
            credentialId: credential.id,
            projectId: params.projectId,
            field: query.field,
          })
          if (result.status === 'not_found') {
            if (!enforceFailedLookupRateLimit(verified.keyId, reply)) return reply
            return reply.status(404).send(CREDENTIAL_NOT_FOUND)
          }
          // Story 13.3 AC-7 — a well-formed `?field=` naming a key absent from this secret;
          // rejected before any decrypt/audit-write, no audit entry written.
          if (result.status === 'unknown_field') {
            return reply.status(400).send({
              code: 'unknown_field_key',
              message: `Unknown field key: '${result.key}'`,
            })
          }

          await writeMachineAuditEntryOrFailClosed(tx, {
            orgId: verified.orgId,
            resourceType: 'credential',
            resourceId: credential.id,
            eventType: AuditEvent.CREDENTIAL_VALUE_REVEALED,
            machineUserId: verified.machineUserId,
            keyId: verified.keyId,
            payload: { versionNumber: result.versionNumber, name },
            // Story 13.3 — first-class column, not nested in payload (see human route).
            revealedFields: result.revealedFields,
            request: req,
          })

          if (result.kind === 'fields') {
            return {
              data: {
                name,
                fields: result.fields,
                versionNumber: result.versionNumber,
                cacheable: credential.cacheable,
              },
            }
          }

          return {
            data: {
              name,
              value: result.value,
              versionNumber: result.versionNumber,
              cacheable: credential.cacheable,
            },
          }
        })
      } catch (error) {
        if (error instanceof SameTransactionAuditWriteError) {
          return reply.status(503).send(AUDIT_WRITE_FAILED)
        }
        throw error
      }
    },
  })
}
