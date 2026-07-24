import { z } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../lib/fastify-app.js'
import { secureRoute } from '../lib/secure-route.js'
import { getExtensionStatus } from './loader.js'

// AC-2/AC-4: OrgAdmin sees the loaded manifest, or a real `null` (not 404, not `{}`) when
// nothing is loaded — a future admin UI page's honest empty state (Product Surface Contract).
const ExtensionStatusResponseSchema = z.union([
  z.object({
    name: z.string(),
    apiVersion: z.string(),
    capabilities: z.array(z.enum(['auth-provider', 'notification-channel', 'ui-panel'])),
    loadedAt: z.string(),
  }),
  z.null(),
])

export async function extensionStatusRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/extensions/status',
    schema: {
      response: {
        200: ExtensionStatusResponseSchema,
      },
    },
    security: {
      // Dev Notes: epics.md/architecture.md's "OrgAdmin" maps 1:1 to this codebase's literal
      // `'admin'` org role — not `['owner', 'admin']` (see AC-5, secure-route.ts's
      // `allowedRoles` semantics).
      allowedRoles: ['admin'],
      requireMfa: true,
      // A read-only status check does not itself need its own audit event — only the *load*
      // (AuditEvent.EXTENSION_LOADED/EXTENSION_LOAD_FAILED, written by loader.ts) is audited.
      writeAuditEvent: false,
    },
    handler: async (_ctx, _req: FastifyRequest, _reply: FastifyReply) => {
      const status = getExtensionStatus()
      if (status.status !== 'loaded') return null
      return {
        name: status.manifest.name,
        apiVersion: status.manifest.apiVersion,
        capabilities: status.manifest.capabilities,
        loadedAt: status.loadedAt,
      }
    },
  })
}
