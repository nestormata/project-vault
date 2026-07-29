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
import { getCompiledThemes } from '../theming/service.js'
import {
  MachineKeySettingsBodySchema,
  MachineKeySettingsResponseSchema,
  OrgDefaultLocaleSettingsBodySchema,
  OrgDefaultLocaleSettingsResponseSchema,
  OrgDefaultThemeSettingsBodySchema,
  OrgDefaultThemeSettingsResponseSchema,
  OrgSettingsParamsSchema,
  UserDormancySettingsBodySchema,
  UserDormancySettingsResponseSchema,
} from './organization-settings-schema.js'
import { UnknownThemeErrorSchema } from '../theming/schema.js'

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
 * Story 15.2 AC 1/6 — Task 2.4's explicit decision (post-elicitation Pre-Mortem Analysis, see the
 * story's Dev Notes): do NOT widen `updateOrgDormancyColumn<K>`'s `Record<K, number>` constraint
 * to `number | string` to accommodate this new string-typed column. That helper is already relied
 * on by two `done` stories' routes; a small parallel handler here, following the identical shape,
 * avoids any regression risk to those routes for the sake of saving a few lines on this third
 * route. Unlike `updateOrgDormancyColumn`, this handler also reads the row's previous value
 * before updating — the audit payload (AC 6) reports both `previousDefaultLocale` and
 * `newDefaultLocale`, whereas the two dormancy routes' audit payloads only report the new value.
 */
async function updateOrgDefaultLocaleColumn(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{
  secureCtx: SecureRouteContext
  previousDefaultLocale: string
  updated: { id: string; defaultLocale: string }
} | null> {
  const params = parseParams(OrgSettingsParamsSchema, req, reply)
  if (!params) return null
  const parsed = parseBody(OrgDefaultLocaleSettingsBodySchema, req, reply)
  if (!parsed.success) return null
  const secureCtx = ctx as SecureRouteContext

  if (params.orgId !== secureCtx.auth.orgId) {
    reply.status(404).send(ORG_NOT_FOUND)
    return null
  }

  const [before] = await secureCtx.tx
    .select({ defaultLocale: organizations.defaultLocale })
    .from(organizations)
    .where(eq(organizations.id, params.orgId))
  if (!before) {
    reply.status(404).send(ORG_NOT_FOUND)
    return null
  }
  const previousDefaultLocale = before.defaultLocale

  const [updated] = await secureCtx.tx
    .update(organizations)
    .set({ defaultLocale: parsed.data.defaultLocale })
    .where(eq(organizations.id, params.orgId))
    .returning({ id: organizations.id, defaultLocale: organizations.defaultLocale })
  if (!updated) {
    reply.status(404).send(ORG_NOT_FOUND)
    return null
  }

  return { secureCtx, previousDefaultLocale, updated }
}

function unknownThemeResponse(themeName: string) {
  return { code: 'unknown_theme' as const, message: `unknown theme '${themeName}'` }
}

/**
 * Story 16.4 Task 2.3 — fourth parallel handler in this file, mirroring
 * `updateOrgDefaultLocaleColumn`'s shape (read-previous-value, cross-org 404, `UPDATE ...
 * RETURNING`). Deliberately NOT folded into `updateOrgDormancyColumn`/`updateOrgDefaultLocaleColumn`
 * — this setting's validation is a dynamic live-list-membership check against `getCompiledThemes()`
 * (mirroring `PATCH /themes/selection`'s own validation exactly), not a numeric enum or a fixed
 * `z.enum`, so it doesn't fit either existing helper's shape. Same "don't touch a helper two/three
 * already-`done` stories' routes depend on" reasoning Story 15.2's Dev Notes already established
 * for this exact file.
 */
async function updateOrgDefaultThemeColumn(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{
  secureCtx: SecureRouteContext
  previousDefaultThemeName: string | null
  updated: { id: string; defaultThemeName: string | null }
} | null> {
  const params = parseParams(OrgSettingsParamsSchema, req, reply)
  if (!params) return null
  const parsed = parseBody(OrgDefaultThemeSettingsBodySchema, req, reply)
  if (!parsed.success) return null
  const secureCtx = ctx as SecureRouteContext

  if (params.orgId !== secureCtx.auth.orgId) {
    reply.status(404).send(ORG_NOT_FOUND)
    return null
  }

  const themeName = parsed.data.themeName
  // AC-1: re-validated against the *live* compiled-themes list at request time, never trusted
  // from a possibly-stale client — same dynamic check `PATCH /themes/selection` already performs
  // (Story 16.2), not a fixed enum (there is none — the valid set changes on every reload).
  if (themeName !== null && !getCompiledThemes().some((theme) => theme.name === themeName)) {
    reply.status(400).send(unknownThemeResponse(themeName))
    return null
  }

  const [before] = await secureCtx.tx
    .select({ defaultThemeName: organizations.defaultThemeName })
    .from(organizations)
    .where(eq(organizations.id, params.orgId))
  if (!before) {
    reply.status(404).send(ORG_NOT_FOUND)
    return null
  }
  const previousDefaultThemeName = before.defaultThemeName

  const [updated] = await secureCtx.tx
    .update(organizations)
    .set({ defaultThemeName: themeName })
    .where(eq(organizations.id, params.orgId))
    .returning({ id: organizations.id, defaultThemeName: organizations.defaultThemeName })
  if (!updated) {
    reply.status(404).send(ORG_NOT_FOUND)
    return null
  }

  return { secureCtx, previousDefaultThemeName, updated }
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

  // Story 15.2 AC 1/5/6/7 — third registration in this shared file, mirroring the two dormancy
  // handlers above (rate limit, minimumRole, requireMfa, and the inline fail-closed audit-write
  // convention route-audit.test.ts's assertAuditedActionOptOutsAreJustified check requires). No
  // GET readback route is added — see the story's Dev Notes ADR "no GET readback for the org
  // default": this page's two existing settings already establish set-only as the deliberate
  // precedent.
  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:orgId/default-locale-settings',
    schema: {
      body: OrgDefaultLocaleSettingsBodySchema,
      response: {
        200: OrgDefaultLocaleSettingsResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'PATCH /api/v1/organizations/:orgId/default-locale-settings',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const result = await updateOrgDefaultLocaleColumn(ctx, req, reply)
      if (!result) return reply
      const { secureCtx, previousDefaultLocale, updated } = result

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'organization',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'organization.default_locale_updated',
        resourceId: updated.id,
        payload: {
          previousDefaultLocale,
          newDefaultLocale: updated.defaultLocale,
        },
        request: req,
      })

      return {
        data: {
          orgId: updated.id,
          defaultLocale: updated.defaultLocale,
        },
      }
    },
  })

  // Story 16.4 AC-1/5/7/8/9 — fourth registration in this shared file, mirroring
  // default-locale-settings' rate limit/minimumRole/requireMfa and inline fail-closed audit-write
  // convention. Unlike default-locale-settings, the 400 `unknown_theme` response (dynamic
  // validation, not a fixed enum's 422) is a distinct documented response code.
  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:orgId/default-theme-settings',
    schema: {
      body: OrgDefaultThemeSettingsBodySchema,
      response: {
        200: OrgDefaultThemeSettingsResponseSchema,
        400: UnknownThemeErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'PATCH /api/v1/organizations/:orgId/default-theme-settings',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const result = await updateOrgDefaultThemeColumn(ctx, req, reply)
      if (!result) return reply
      const { secureCtx, previousDefaultThemeName, updated } = result

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'organization',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'organization.default_theme_updated',
        resourceId: updated.id,
        payload: {
          previousDefaultThemeName,
          newDefaultThemeName: updated.defaultThemeName,
        },
        request: req,
      })

      // AC-10: request-scoped debug-level operational visibility, not the shared
      // operationalLog() helper — same reasoning Story 16.2 AC-9 documented (operationalLog() is
      // reserved for non-request-scoped startup/job logging and would mask this request's trace).
      req.log.debug(
        {
          userId: secureCtx.auth.userId,
          from: previousDefaultThemeName,
          to: updated.defaultThemeName,
        },
        'org_default_theme_changed'
      )

      return {
        data: {
          orgId: updated.id,
          defaultThemeName: updated.defaultThemeName,
        },
      }
    },
  })
}
