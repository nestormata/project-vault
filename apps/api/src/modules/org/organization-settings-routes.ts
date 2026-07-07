import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ZodType } from 'zod/v4'
import { organizations } from '@project-vault/db/schema'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import {
  secureRoute,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import {
  MachineKeySettingsBodySchema,
  MachineKeySettingsResponseSchema,
  OrgSettingsParamsSchema,
  UserDormancySettingsBodySchema,
  UserDormancySettingsResponseSchema,
} from './organization-settings-schema.js'

const ORG_NOT_FOUND = { code: 'org_not_found', message: 'Organization not found' } as const

/**
 * Shared by both dormancy-threshold settings handlers below (machine-key and, per Story 8.3 D5,
 * user) — parses `:orgId`/body, checks the cross-org guard, and updates the given column on
 * `organizations`, all within the caller's transaction. Deliberately stops short of writing the
 * audit row: route-audit.test.ts's assertAuditedActionOptOutsAreJustified check statically
 * requires the literal `writeHumanAuditEntryOrFailClosed(...secureCtx.tx...)` call to appear
 * inside each route's own `secureRoute(...)` registration, so that call (and the response it
 * feeds) stays inline per-route below rather than moving into this helper.
 */
async function updateOrgDormancyColumn<
  K extends 'machineKeyDormancyThresholdDays' | 'userDormancyThresholdDays',
>(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  bodySchema: ZodType,
  columnKey: K
): Promise<{ secureCtx: SecureRouteContext; updated: { id: string } & Record<K, number> } | null> {
  const params = parseParams(OrgSettingsParamsSchema, req, reply)
  if (!params) return null
  const parsed = parseBody(bodySchema, req, reply)
  if (!parsed.success) return null
  const secureCtx = ctx as SecureRouteContext

  if (params.orgId !== secureCtx.auth.orgId) {
    reply.status(404).send(ORG_NOT_FOUND)
    return null
  }

  const value = (parsed.data as Record<K, number>)[columnKey]
  const [updated] = await secureCtx.tx
    .update(organizations)
    .set({ [columnKey]: value } as Partial<typeof organizations.$inferInsert>)
    .where(eq(organizations.id, params.orgId))
    .returning()
  if (!updated) {
    reply.status(404).send(ORG_NOT_FOUND)
    return null
  }

  return { secureCtx, updated: updated as { id: string } & Record<K, number> }
}

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
      const result = await updateOrgDormancyColumn(
        ctx,
        req,
        reply,
        MachineKeySettingsBodySchema,
        'machineKeyDormancyThresholdDays'
      )
      if (!result) return reply
      const { secureCtx, updated } = result

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

  // Story 8.3 D5/AC-12 — second registration in this shared file (Story 7.2 D8's own multi-
  // setting-in-one-file convention), mirroring the machine-key-settings handler above exactly.
  // Deliberately inlined (not delegated to a shared helper function): route-audit.test.ts's
  // assertAuditedActionOptOutsAreJustified check statically parses each secureRoute(...) call's
  // own source text for a literal writeHumanAuditEntryOrFailClosed(...secureCtx.tx...) call, so
  // the audit-write opt-out (writeAuditEvent: false) must be textually visible inside this call.
  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:orgId/user-dormancy-settings',
    schema: {
      body: UserDormancySettingsBodySchema,
      response: {
        200: UserDormancySettingsResponseSchema,
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
        key: 'PATCH /api/v1/organizations/:orgId/user-dormancy-settings',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const result = await updateOrgDormancyColumn(
        ctx,
        req,
        reply,
        UserDormancySettingsBodySchema,
        'userDormancyThresholdDays'
      )
      if (!result) return reply
      const { secureCtx, updated } = result

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'organization',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'organization.user_dormancy_settings_updated',
        resourceId: updated.id,
        payload: { userDormancyThresholdDays: updated.userDormancyThresholdDays },
        request: req,
      })

      return {
        data: {
          orgId: updated.id,
          userDormancyThresholdDays: updated.userDormancyThresholdDays,
        },
      }
    },
  })
}
