import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../lib/errors.js'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

export function requireOrgRole(...roles: OrgRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authContext = request.authContext
    if (!authContext) {
      return reply
        .status(401)
        .send({ code: 'access_token_missing', message: 'Access token is missing' })
    }
    if (!roles.includes(authContext.orgRole)) {
      const error = new AppError('insufficient_role', 'Insufficient permissions', 403)
      return reply.status(error.statusCode).send({ code: error.code, message: error.message })
    }
  }
}
