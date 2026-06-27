import type { FastifyApp } from '../../lib/fastify-app.js'
import { buildSecurePreHandlers } from '../../lib/secure-route.js'

export function registerPrivilegedTestRoute(fastify: FastifyApp): void {
  fastify.route({
    method: 'POST',
    url: '/api/v1/test/privileged-action',
    preHandler: buildSecurePreHandlers(fastify, {
      requireMfa: true,
      requireOrgRole: ['owner', 'admin'],
    }),
    handler: async () => ({ ok: true, action: 'privileged_mock' }),
  })
}
