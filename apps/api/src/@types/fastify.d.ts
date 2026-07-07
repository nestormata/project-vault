import type { FastifyReply } from 'fastify'

declare module 'fastify' {
  type AuthContext = {
    userId: string
    orgId: string
    sessionId: string
    jti: string
    sessionVersion: number
    orgRole: 'owner' | 'admin' | 'member' | 'viewer'
    // Story 9.1 D1: instance-wide (not org-scoped) authorization flag, populated from
    // users.is_platform_operator at JWT-verification time — same place orgRole is populated.
    isPlatformOperator: boolean
  }

  interface FastifyRequest {
    authContext?: AuthContext
  }

  interface FastifyInstance {
    authenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  }
}
