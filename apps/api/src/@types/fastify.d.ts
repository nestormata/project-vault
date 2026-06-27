import type { FastifyReply } from 'fastify'

declare module 'fastify' {
  type AuthContext = {
    userId: string
    orgId: string
    sessionId: string
    jti: string
    sessionVersion: number
    orgRole: 'owner' | 'admin' | 'member' | 'viewer'
  }

  interface FastifyRequest {
    authContext?: AuthContext
  }

  interface FastifyInstance {
    authenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  }
}
