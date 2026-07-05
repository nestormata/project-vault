import { eq } from 'drizzle-orm'
import { organizations } from '@project-vault/db/schema'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import {
  MachineKeySettingsBodySchema,
  MachineKeySettingsResponseSchema,
  OrgSettingsParamsSchema,
} from './organization-settings-schema.js'

const ORG_NOT_FOUND = { code: 'org_not_found', message: 'Organization not found' } as const

/**
 * Story 7.2 D8 — the only way to change `machine_key_dormancy_threshold_days` in this story; no
 * broader settings UI/module is implied. A future org-context mismatch (`:orgId` not the
 * caller's own org) is treated as 404 — same non-leaking pattern every other org/project-scoped
 * route in this codebase uses.
 */
export async function organizationSettingsRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:orgId/machine-key-settings',
    schema: {
      body: MachineKeySettingsBodySchema,
      response: {
        200: MachineKeySettingsResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'PATCH /api/v1/organizations/:orgId/machine-key-settings',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(OrgSettingsParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(MachineKeySettingsBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      if (params.orgId !== secureCtx.auth.orgId) return reply.status(404).send(ORG_NOT_FOUND)

      const [updated] = await secureCtx.tx
        .update(organizations)
        .set({ machineKeyDormancyThresholdDays: parsed.data.machineKeyDormancyThresholdDays })
        .where(eq(organizations.id, params.orgId))
        .returning({
          id: organizations.id,
          machineKeyDormancyThresholdDays: organizations.machineKeyDormancyThresholdDays,
        })
      if (!updated) return reply.status(404).send(ORG_NOT_FOUND)

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'organization',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'organization.machine_key_settings_updated',
        resourceId: updated.id,
        payload: { machineKeyDormancyThresholdDays: updated.machineKeyDormancyThresholdDays },
        request: req,
      })

      return {
        data: {
          orgId: updated.id,
          machineKeyDormancyThresholdDays: updated.machineKeyDormancyThresholdDays,
        },
      }
    },
  })
}
