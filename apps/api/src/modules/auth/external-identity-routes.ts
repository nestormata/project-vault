import { z } from 'zod/v4'
import { and, eq } from 'drizzle-orm'
import { externalIdentities, orgMemberships } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { isUniqueViolation } from './service.js'

const LinkExternalIdentityBodySchema = z.object({
  userId: z.string().uuid(),
  providerName: z.string().min(1),
  externalSubject: z.string().min(1),
})

/**
 * Story 14.3 AC-10: explicit OrgAdmin-initiated linking action. Uses `secureRoute()` with
 * `allowedRoles: ['admin']` (not `['owner', 'admin']`, per Story 14.2's reused RBAC judgment
 * call) and `requireMfa: true`, matching architecture.md's "OrgAdmin" → literal `'admin'` role
 * string convention.
 */
export async function externalIdentityRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/external-identities',
    schema: { body: LinkExternalIdentityBodySchema },
    security: {
      allowedRoles: ['admin'],
      requireMfa: true,
      // Audit is written manually below, inside the same tx, only on the success path — a
      // static writeAuditEvent config would install secureRoute's audit-send-guard, which
      // forbids the 404/409 error branches below from calling reply.send() directly (mirrors
      // credentials/routes.ts's createCredentialWithFirstVersion precedent).
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const { userId, providerName, externalSubject } = req.body as z.infer<
        typeof LinkExternalIdentityBodySchema
      >

      // Edge case: userId not a member of the caller's org — 404, never leaking whether the user
      // exists in a different org.
      const [membership] = await secureCtx.tx
        .select({ userId: orgMemberships.userId })
        .from(orgMemberships)
        .where(
          and(eq(orgMemberships.orgId, secureCtx.auth.orgId), eq(orgMemberships.userId, userId))
        )
        .limit(1)
      if (!membership) {
        return reply.status(404).send({ code: 'user_not_found', message: 'User not found' })
      }

      try {
        const [row] = await secureCtx.tx
          .insert(externalIdentities)
          .values({ orgId: secureCtx.auth.orgId, userId, providerName, externalSubject })
          .returning({
            id: externalIdentities.id,
            orgId: externalIdentities.orgId,
            userId: externalIdentities.userId,
            providerName: externalIdentities.providerName,
            externalSubject: externalIdentities.externalSubject,
            createdAt: externalIdentities.createdAt,
          })
        if (!row) throw new Error('external identity insert returned no row')

        await writeHumanAuditEntry(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorTokenId: await firstActorTokenIdForUser(secureCtx.tx, secureCtx.auth.userId),
          eventType: AuditEvent.EXTERNAL_IDENTITY_LINKED,
          resourceId: row.id,
          resourceType: 'external_identity',
          payload: { providerName },
        })

        reply.status(201)
        return { data: row }
      } catch (error) {
        if (isUniqueViolation(error, 'idx_external_identities_org_provider_subject')) {
          return reply
            .status(409)
            .send({ code: 'conflict', message: 'This external identity is already linked' })
        }
        throw error
      }
    },
  })
}
