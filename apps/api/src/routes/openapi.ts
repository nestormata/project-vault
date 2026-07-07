import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyApp } from '../lib/fastify-app.js'

/**
 * Story 9.3 D5/AC-6: `GET /api/v1/openapi.json` returns the exact same document
 * `fastify.swagger()` produces — `@fastify/swagger-ui` does not automatically expose the raw
 * JSON at a caller-chosen path, so this is a thin, explicit handler. Registered as a raw
 * `fastify.get()` (not `secureRoute()`) — same pattern as `routes/health.ts` — since this route
 * is intentionally unauthenticated; `apps/api/src/lib/route-exemptions.ts`'s
 * `PUBLIC_ROUTE_EXEMPTIONS` documents why. Only registered at all when `docsEnabled()` is true —
 * conditionally skipping registration (rather than registering then 403-ing) so a gated-off
 * instance's spec never lists this route either, per AC-6's "absence carries no information
 * leak" requirement.
 */
export async function openapiRoutes(fastify: FastifyApp): Promise<void> {
  fastify.get('/openapi.json', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(fastify.swagger())
  })
}
