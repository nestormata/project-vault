import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { env } from '../../config/env.js'
import { reloadThemes } from './service.js'
import { ThemeReloadResponseSchema } from './schema.js'

/**
 * Story 16.1 AC-1/AC-7: OrgAdmin-only, MFA-required, rate-limited manual reload trigger — closely
 * mirrors modules/admin/routes.ts's POST /notifications/test wiring (same allowedRoles/requireMfa
 * shape, same { max: 10 } rate-limit precedent given this endpoint also does real filesystem +
 * validation work per call).
 *
 * `writeAuditEvent: false` + a direct `writeHumanAuditEntryOrFailClosed(secureCtx.tx, ...)` call
 * (rather than SecureRoute's generic `writeAuditEvent: <AuditConfig>` mechanism) because the audit
 * payload needs the reload's own computed result (loadedCount/failedCount/failedFiles) —
 * SecureRoute's built-in `AuditConfig.payload` callback only ever receives `{ params, query }`,
 * never the handler's return value. Calling this helper directly still gets the exact same
 * fail-closed guarantee (`SameTransactionAuditWriteError` -> 503 `audit_write_failed`) as the
 * generic path, per this codebase's established `sameTransactionAuditService` convention (see
 * route-exemptions.ts).
 */
export async function themingRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/themes/reload',
    schema: {
      response: {
        200: ThemeReloadResponseSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin'],
      requireMfa: true,
      rateLimit: { max: 10, key: 'POST /admin/themes/reload' },
      writeAuditEvent: false,
    },
    handler: async (secureCtx, req: FastifyRequest, _reply: FastifyReply) => {
      const ctx = secureCtx as SecureRouteContext
      const result = await reloadThemes(env.VAULT_THEMES_DIR)

      // AC-7: never include raw theme file contents in the audit payload — filenames and counts
      // only (Dev Notes "audit payload sanitization").
      await writeHumanAuditEntryOrFailClosed(ctx.tx, {
        orgId: ctx.auth.orgId,
        actorUserId: ctx.auth.userId,
        eventType: AuditEvent.THEME_RELOADED,
        resourceType: 'theme_reload',
        payload: {
          loadedCount: result.loaded.length,
          failedCount: result.failed.length,
          failedFiles: result.failed.map((f) => f.file),
        },
        request: req,
      })

      return result
    },
  })
}
