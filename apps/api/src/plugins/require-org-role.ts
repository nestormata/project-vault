import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../lib/errors.js'
import { requireAuthContext } from '../lib/route-helpers.js'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

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
