import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { organizations, users } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { parseBody } from '../../lib/route-helpers.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { getCompiledThemes } from './service.js'
import {
  ThemeListResponseSchema,
  ThemeSelectionBodySchema,
  ThemeSelectionResponseSchema,
  UnknownThemeErrorSchema,
} from './schema.js'

// Story 16.2 AC-1/AC-3: the base theme is never part of 16.1's compiled-themes list (it never
// gets a `[data-theme="base"]` CSS block — it's just the app's default stylesheet), but it is
// always a selectable, always-first option here.
const BASE_THEME = { name: 'base', label: 'Default', css: null } as const

function unknownThemeResponse(themeName: string) {
  return { code: 'unknown_theme' as const, message: `unknown theme '${themeName}'` }
}

/**
 * Story 16.2: personal, per-user theme *selection* — a distinct, separately-mounted route family
 * from 16.1's OrgAdmin-only `POST /admin/themes/reload` (registered at `/api/v1/admin` in
 * app.ts). These two routes are mounted at plain `/api/v1` instead, so they deliberately live in
 * their own file rather than being folded into `theming/routes.ts` — route-audit.test.ts resolves
 * each route's prefix from the *file*, not the individual `secureRoute()` call, so mixing two
 * different prefixes in one file/registrar would misclassify one family's routes.
 *
 * `writeAuditEvent: false` + the inline `writeHumanAuditEntryOrFailClosed(...secureCtx.tx...)`
 * call in the PATCH handler below (not SecureRoute's generic `writeAuditEvent: <AuditConfig>`
 * mechanism) — confirmed via direct inspection of `secure-route.ts` that `AuditConfig.payload`
 * only ever receives `{ params, query }`, never the request body or a handler-computed
 * `previousThemeName` DB lookup. Every existing body/DB-derived-payload route in this codebase
 * (e.g. `PATCH /api/v1/users/me/locale`) uses this same inline pattern for the same reason — see
 * route-audit.test.ts's `assertAuditedActionOptOutsAreJustified` static check, which requires this
 * call to stay textually inline in the route registration.
 */
export async function themeSelectionRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/themes',
    schema: {
      response: {
        200: ThemeListResponseSchema,
        401: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'viewer',
      requireMfa: false,
      writeAuditEvent: false,
    },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const [row] = await secureCtx.tx
        .select({ selectedThemeName: users.selectedThemeName })
        .from(users)
        .where(eq(users.id, secureCtx.auth.userId))

      // Story 16.4 AC-2/AC-4: scoped strictly by the authenticated session's own orgId — never a
      // client-suppliable org id — so a caller can only ever see their own org's default.
      const [orgRow] = await secureCtx.tx
        .select({ defaultThemeName: organizations.defaultThemeName })
        .from(organizations)
        .where(eq(organizations.id, secureCtx.auth.orgId))

      const themes = [
        BASE_THEME,
        ...getCompiledThemes().map((theme) => ({
          name: theme.name,
          label: theme.name,
          css: theme.css,
        })),
      ]

      return {
        themes,
        selected: row?.selectedThemeName ?? null,
        orgDefaultThemeName: orgRow?.defaultThemeName ?? null,
      }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/themes/selection',
    schema: {
      body: ThemeSelectionBodySchema,
      response: {
        200: ThemeSelectionResponseSchema,
        400: UnknownThemeErrorSchema,
        401: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'viewer',
      requireMfa: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'PATCH /api/v1/themes/selection' },
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseBody(ThemeSelectionBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext
      const themeName = parsed.data.themeName

      // AC-2: re-validated against the *live* compiled-themes list at request time, never trusted
      // from the client's possibly-stale page state.
      if (themeName !== null && !getCompiledThemes().some((theme) => theme.name === themeName)) {
        return reply.status(400).send(unknownThemeResponse(themeName))
      }

      const [before] = await secureCtx.tx
        .select({ selectedThemeName: users.selectedThemeName })
        .from(users)
        .where(eq(users.id, secureCtx.auth.userId))
      const previousThemeName = before?.selectedThemeName ?? null

      // The authenticated session guarantees a `users` row for secureCtx.auth.userId exists (it's
      // the foreign key the session itself was resolved from) — an empty UPDATE result here would
      // indicate a deeper auth-context bug, not a normal client-reachable case.
      const [updated] = await secureCtx.tx
        .update(users)
        .set({ selectedThemeName: themeName })
        .where(eq(users.id, secureCtx.auth.userId))
        .returning({ selectedThemeName: users.selectedThemeName })
      if (!updated) {
        throw new Error(
          'users.selected_theme_name update affected no rows for an authenticated session'
        )
      }

      // AC-9: request-scoped debug-level operational visibility, deliberately NOT via the shared
      // operationalLog() helper — that helper's own doc comment (lib/logger.ts) reserves it for
      // non-request-scoped (startup/job) logging and always stamps SYSTEM_TRACE_ID, which would
      // mask this request's real trace ID. `req.log` is this codebase's standard request-scoped
      // structured logger.
      req.log.debug(
        { userId: secureCtx.auth.userId, from: previousThemeName, to: themeName },
        'theme_selection_changed'
      )

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'user',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.THEME_SELECTED,
        resourceId: secureCtx.auth.userId,
        payload: { themeName, previousThemeName },
        request: req,
      })

      return { themeName: updated.selectedThemeName }
    },
  })
}
