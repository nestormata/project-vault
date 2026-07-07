import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../lib/errors.js'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'
export type AuthContext = NonNullable<FastifyRequest['authContext']>

/**
 * Shared by requireOrgRole and requirePlatformOperator (same preHandler shape, different
 * authorization axis) — sends the 401 and returns undefined when no auth context is present,
 * otherwise returns it so the caller can apply its own role/flag check (jscpd dedup).
 */
export function requireAuthContext(
  request: FastifyRequest,
  reply: FastifyReply
): AuthContext | undefined {
  const authContext = request.authContext
  if (!authContext) {
    reply.status(401).send({ code: 'access_token_missing', message: 'Access token is missing' })
    return undefined
  }
  return authContext
}

export function requireOrgRole(...roles: OrgRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authContext = requireAuthContext(request, reply)
    if (!authContext) {
      return
    }
    if (!roles.includes(authContext.orgRole)) {
      const error = new AppError('insufficient_role', 'Insufficient permissions', 403)
      return reply.status(error.statusCode).send({ code: error.code, message: error.message })
    }
  }
}
