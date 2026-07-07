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
 * user) — parses `:orgId`/body, checks the cross-org guard, updates the given column on
 * `organizations`, and writes the matching audit row, all in the same transaction.
 *
 * NOTE: only this HANDLER BODY is shared — each route below still registers its own full,
 * literal `secureRoute({ method, url, schema, security, ... })` call. `apps/api/src/__tests__/
 * route-audit.test.ts` statically parses this file's AST for literal `method`/`url`/`security`
 * values (it cannot resolve a url threaded through a runtime config object/function parameter,
 * which is exactly the shape an earlier version of this file used and which the route-audit
 * suite correctly flagged as an unclassifiable `<dynamic>` route) — so this shared function's
 * own signature carries no part of the `secureRoute` registration shape, only the already-
 * distinct-per-route body schema/column/event values each `handler:` passes in.
 */
async function handleDormancyThresholdUpdate(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  bodySchema: ZodType,
  columnKey: 'machineKeyDormancyThresholdDays' | 'userDormancyThresholdDays',
  eventType: string
): Promise<unknown> {
  const params = parseParams(OrgSettingsParamsSchema, req, reply)
  if (!params) return reply
  const parsed = parseBody(bodySchema, req, reply)
  if (!parsed.success) return reply
  const secureCtx = ctx as SecureRouteContext

  if (params.orgId !== secureCtx.auth.orgId) return reply.status(404).send(ORG_NOT_FOUND)

  const value = (parsed.data as Record<string, number>)[columnKey]
  const [updated] = await secureCtx.tx
    .update(organizations)
    .set({ [columnKey]: value } as Partial<typeof organizations.$inferInsert>)
    .where(eq(organizations.id, params.orgId))
    .returning()
  if (!updated) return reply.status(404).send(ORG_NOT_FOUND)

  await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
    resourceType: 'organization',
    orgId: secureCtx.auth.orgId,
    actorUserId: secureCtx.auth.userId,
    eventType,
    resourceId: updated.id,
    payload: { [columnKey]: value },
    request: req,
  })

  return { data: { orgId: updated.id, [columnKey]: updated[columnKey] } }
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
    handler: (ctx, req, reply) =>
      handleDormancyThresholdUpdate(
        ctx,
        req,
        reply,
        MachineKeySettingsBodySchema,
        'machineKeyDormancyThresholdDays',
        'organization.machine_key_settings_updated'
      ),
  })

  // Story 8.3 D5/AC-12 — second registration in this shared file (Story 7.2 D8's own multi-
  // setting-in-one-file convention), mirroring the machine-key-settings handler above exactly.
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
    handler: (ctx, req, reply) =>
      handleDormancyThresholdUpdate(
        ctx,
        req,
        reply,
        UserDormancySettingsBodySchema,
        'userDormancyThresholdDays',
        'organization.user_dormancy_settings_updated'
      ),
  })
}
