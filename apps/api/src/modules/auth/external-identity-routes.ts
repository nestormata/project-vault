import { z } from 'zod/v4'
import { and, desc, eq } from 'drizzle-orm'
import { externalIdentities, orgMemberships, users } from '@project-vault/db/schema'
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

const ExternalIdentityParamsSchema = z.object({ id: z.string().uuid() })

const NOT_FOUND = { code: 'not_found', message: 'External identity not found' } as const

/**
 * Story 14.3 AC-10: explicit OrgAdmin-initiated linking action. Uses `secureRoute()` with
 * `allowedRoles: ['admin']` (not `['owner', 'admin']`, per Story 14.2's reused RBAC judgment
 * call) and `requireMfa: true`, matching architecture.md's "OrgAdmin" → literal `'admin'` role
 * string convention.
 */
export async function externalIdentityRoutes(fastify: FastifyApp): Promise<void> {
  // Story 14.7 AC-1: list, org-scoped via secureCtx.tx's RLS-scoped transaction — never
  // getAdminDb(). AC-4: allowedRoles: ['admin'] (not minimumRole) — matches this file's existing
  // POST route (see AC-4's Judgment Call in the story: owner is deliberately excluded here,
  // unlike 14-6's minimumRole convention, for internal file-level consistency). AC-5: requireMfa
  // applies to the read-only list too — account-linkage metadata is sensitive.
  secureRoute(fastify, {
    method: 'GET',
    url: '/external-identities',
    security: {
      allowedRoles: ['admin'],
      requireMfa: true,
      writeAuditEvent: false, // AC-6: list route writes no audit event (read of one's own org).
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/admin/external-identities' },
    },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const rows = await secureCtx.tx
        .select({
          id: externalIdentities.id,
          userId: externalIdentities.userId,
          email: users.email,
          providerName: externalIdentities.providerName,
          externalSubject: externalIdentities.externalSubject,
          createdAt: externalIdentities.createdAt,
        })
        .from(externalIdentities)
        .innerJoin(users, eq(users.id, externalIdentities.userId))
        .where(eq(externalIdentities.orgId, secureCtx.auth.orgId))
        .orderBy(desc(externalIdentities.createdAt))
      return { data: rows }
    },
  })

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

  // Story 14.7 AC-3: hard-delete, org-scoped WHERE clause is the delete-race analog to the
  // create path's unique-index-violation handling (AC-7) — the first request to commit wins
  // (200), the second finds zero matching rows (404), never a crash or duplicate audit entry.
  secureRoute(fastify, {
    method: 'DELETE',
    url: '/external-identities/:id',
    schema: { params: ExternalIdentityParamsSchema },
    security: {
      allowedRoles: ['admin'],
      requireMfa: true,
      writeAuditEvent: false, // Audit is written manually below, inside the same tx.
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'DELETE /api/v1/admin/external-identities' },
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const { id } = req.params as z.infer<typeof ExternalIdentityParamsSchema>

      const [row] = await secureCtx.tx
        .delete(externalIdentities)
        .where(
          and(eq(externalIdentities.id, id), eq(externalIdentities.orgId, secureCtx.auth.orgId))
        )
        .returning({
          id: externalIdentities.id,
          userId: externalIdentities.userId,
          providerName: externalIdentities.providerName,
          externalSubject: externalIdentities.externalSubject,
        })

      // AC-3 edge: cross-org/nonexistent :id -> 404, never 403 (do not confirm the row's
      // existence in another org).
      if (!row) return reply.status(404).send(NOT_FOUND)

      await writeHumanAuditEntry(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorTokenId: await firstActorTokenIdForUser(secureCtx.tx, secureCtx.auth.userId),
        eventType: AuditEvent.EXTERNAL_IDENTITY_UNLINKED,
        resourceId: row.id,
        resourceType: 'external_identity',
        payload: {
          providerName: row.providerName,
          externalSubject: row.externalSubject,
          unlinkedUserId: row.userId,
        },
      })

      return { data: row }
    },
  })
}
