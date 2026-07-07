import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Story 9.1 D1: backup/restore (and any future instance-wide admin operation) is gated by the
 * `users.is_platform_operator` flag — an authorization concept orthogonal to, and independent of,
 * any org-scoped role (`requireOrgRole`). Colocated next to `requireOrgRole` since it is the same
 * shape of preHandler, just checking a different axis of authorization.
 */
export function requirePlatformOperator() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authContext = request.authContext
    if (!authContext) {
      return reply
        .status(401)
        .send({ code: 'access_token_missing', message: 'Access token is missing' })
    }
    if (!authContext.isPlatformOperator) {
      return reply.status(403).send({
        code: 'platform_operator_required',
        message: 'This endpoint requires platform operator privileges.',
      })
    }
  }
}
