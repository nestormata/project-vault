import type { FastifyReply } from 'fastify'

declare module 'fastify' {
  type AuthContext = {
    userId: string
    orgId: string
    sessionId: string
    jti: string
    sessionVersion: number
    // Story 71.3: absent for a service-delegated actor that is not a verified member (an unlinked
    // actor has no PV role). Every reader treats absence as "no role": fail closed.
    orgRole?: 'owner' | 'admin' | 'member' | 'viewer'
    // Story 9.1 D1: instance-wide (not org-scoped) authorization flag, populated from
    // users.is_platform_operator at JWT-verification time — same place orgRole is populated.
    isPlatformOperator: boolean
    // Story 71.3: set only by the delegation stages. `sessionId` is then the literal 'delegation'
    // and there is no session row behind this context.
    delegation?: true
  }

  // Story 71.3: what a delegated handler reads as `ctx.delegation` (the extension-api
  // `ApiRouteDelegation` shape). Set only by the delegation stages of a delegated route.
  type DelegationContext = {
    orgId: string
    actorId: string
    actorProvider: string
    actorUserId: string | null
    actorAttestation: 'pv_verified' | 'issuer_attested'
    delegatedBy: { kid: string; issuer: string }
    assertionId: string
    issuedAt: number
    operation: string
  }

  interface FastifyRequest {
    authContext?: AuthContext
    delegationContext?: DelegationContext
  }

  interface FastifyInstance {
    authenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  }
}
