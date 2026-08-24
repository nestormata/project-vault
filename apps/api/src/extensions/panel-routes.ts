import { z } from 'zod/v4'
import type { FastifyRequest } from 'fastify'
import type { FastifyApp } from '../lib/fastify-app.js'
import { ApiErrorSchema } from '../lib/api-contracts.js'
import { secureRoute } from '../lib/secure-route.js'
import {
  isUiPanelCapabilityDeclared,
  renderExtensionPanel,
  resolveKnownUiPanelSlots,
} from '../lib/extension-panel.js'
import { getExtensionStatus } from './loader.js'

const ExtensionPanelParamsSchema = z.object({ slot: z.string() })

const ExtensionPanelOkSchema = z.object({ ok: z.literal(true), html: z.string() })
const ExtensionPanelUnavailableSchema = z.object({
  ok: z.literal(false),
  reason: z.literal('panel_unavailable'),
})

const ExtensionNavSchema = z.object({
  // Story 25.1 AC5: `null` when no nav entry should be shown at all (no extension loaded, or the
  // loaded extension does not declare the `'ui-panel'` capability) — never a dead link by
  // default. Story 25.2 AC5: a non-null value is the FIRST entry of the dynamically resolved
  // known-slots list (`resolveKnownUiPanelSlots(status)[0]`) — still exactly one slot reported;
  // enumerating multiple nav entries per declared slot is deferred to Story 25.8.
  uiPanelSlot: z.string().nullable(),
})

/**
 * Story 25.1 — `GET /api/v1/extensions/panels/:slot` (AC1/AC2/AC3/AC3b) and
 * `GET /api/v1/extensions/nav` (AC5).
 *
 * The nav-availability route is a small addition beyond this story's originally-scoped single
 * route: `(app)/+layout.server.ts` runs in `apps/web`'s own server process, a separate service
 * from `apps/api` — it has no in-process way to read `getExtensionStatus()`, and the existing
 * admin-only `GET /api/v1/admin/extensions/status` route (Story 14.2) cannot be reused here
 * because AC1 deliberately opens panels to any active org member, not just admins, and because
 * the panels route's own degraded response (AC3) deliberately collapses "hook is gone" and "hook
 * threw/timed out" into the same `panel_unavailable` shape — exactly the two states AC5 needs to
 * tell apart (a permanently-absent hook hides the nav entry; a transient failure must not, since
 * that is what AC3's degraded page state is for). This route answers only the AC5 question
 * ("is there a nav entry to show, and if so, to which slot"), reusing the exact same
 * `isUiPanelCapabilityDeclared()` capability-declaration check, at the exact same any-org-member
 * security profile as the panels route itself.
 */
export async function extensionPanelRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/extensions/panels/:slot',
    schema: {
      params: ExtensionPanelParamsSchema,
      response: {
        200: z.union([ExtensionPanelOkSchema, ExtensionPanelUnavailableSchema]),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
      },
    },
    security: {
      // AC1: intentionally open to any active org member — no allowedRoles restriction, unlike
      // status-routes.ts's admin-only diagnostics view. AC2: identity/org come from
      // `request.authContext` (resolved by secureRoute() itself from the session cookie) — this
      // handler never reads an identity/org claim from the request body, query, or headers.
      requireAuth: true,
      writeAuditEvent: false,
    },
    handler: async (_ctx, req: FastifyRequest, reply) => {
      const { slot } = req.params as { slot: string }
      // Story 25.2 AC3: resolved fresh from getExtensionStatus() on every request, never a
      // module-level constant — a slot the currently loaded extension's manifest doesn't
      // declare 400s here even if the hook itself would have handled it gracefully.
      const knownSlots = resolveKnownUiPanelSlots(getExtensionStatus(), req.log)
      const result = await renderExtensionPanel(slot, knownSlots, req.log)

      if (result.outcome === 'invalid_slot') {
        return reply
          .status(400)
          .send({ code: 'invalid_slot', message: 'Unknown or malformed panel slot' })
      }
      if (result.outcome === 'unavailable') {
        return { ok: false as const, reason: 'panel_unavailable' as const }
      }
      return { ok: true as const, html: result.html }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/extensions/nav',
    schema: {
      response: {
        200: ExtensionNavSchema,
        401: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: true,
      writeAuditEvent: false,
    },
    handler: async (_ctx, req: FastifyRequest) => {
      // Story 25.2 AC5: derives the single reported slot from the dynamic known-slots list's
      // first entry, instead of the old KNOWN_UI_PANEL_SLOTS[0] constant reference. Still
      // exactly one slot reported — no per-declared-slot nav enumeration (deferred to 25.8).
      const knownSlots = resolveKnownUiPanelSlots(getExtensionStatus(), req.log)
      return { uiPanelSlot: isUiPanelCapabilityDeclared() ? knownSlots[0] : null }
    },
  })
}
