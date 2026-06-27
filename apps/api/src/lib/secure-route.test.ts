import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildSecurePreHandlers, type SecureRouteOptions } from './secure-route.js'

describe('buildSecurePreHandlers', () => {
  it('builds auth, org-role, then MFA preHandlers when requireMfa is true', () => {
    const authenticate = async () => undefined
    const fastify = { authenticate } as unknown as FastifyInstance
    const options: SecureRouteOptions = {
      requireOrgRole: ['owner', 'admin'],
      requireMfa: true,
    }

    const handlers = buildSecurePreHandlers(fastify, options)

    expect(handlers).toHaveLength(3)
    expect(handlers[0]).toBe(authenticate)
  })

  it('omits auth and MFA when explicitly disabled or unset', () => {
    const fastify = { authenticate: async () => undefined } as unknown as FastifyInstance

    expect(buildSecurePreHandlers(fastify, { requireAuth: false })).toHaveLength(0)
    expect(buildSecurePreHandlers(fastify, { requireOrgRole: ['owner'] })).toHaveLength(2)
  })
})
