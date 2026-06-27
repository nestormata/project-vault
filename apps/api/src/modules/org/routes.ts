import { and, eq } from 'drizzle-orm'
import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import { getDb } from '@project-vault/db'
import { orgMemberships } from '@project-vault/db/schema'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { authPreHandler, enforceUserRateLimit, validationError } from '../../lib/route-helpers.js'
import { requireOrgRole } from '../../plugins/require-org-role.js'
import { revokeAllUserSessionsInOrg } from '../auth/session-revoke.js'
import { OrgUserParamsSchema } from './schema.js'

export async function orgRoutes(fastify: FastifyApp): Promise<void> {
  fastify.route({
    method: 'DELETE',
    url: '/users/:userId/sessions',
    preHandler: [authPreHandler(fastify), requireOrgRole('admin', 'owner')],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const authContext = req.authContext
      if (!authContext) {
        return reply
          .status(401)
          .send({ code: 'access_token_missing', message: 'Access token is missing' })
      }
      if (
        !enforceUserRateLimit({
          userId: authContext.userId,
          key: 'DELETE /org/users/:userId/sessions',
          max: 20,
          reply,
        })
      ) {
        return reply
      }
      const parsed = OrgUserParamsSchema.safeParse(req.params)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'params'))

      const targetMembership = await getDb()
        .select({ userId: orgMemberships.userId })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.userId, parsed.data.userId),
            eq(orgMemberships.orgId, authContext.orgId),
            eq(orgMemberships.status, 'active')
          )
        )
        .limit(1)
      if (!targetMembership[0]) {
        return reply.status(404).send({ code: 'user_not_found', message: 'User not found' })
      }

      const result = await revokeAllUserSessionsInOrg({
        userId: parsed.data.userId,
        orgId: authContext.orgId,
        actorUserId: authContext.userId,
        reason: 'admin_action',
      })

      return reply.send({ data: { ...result, userId: parsed.data.userId } })
    },
  })
}
