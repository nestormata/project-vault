import { z } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../lib/fastify-app.js'
import { ApiErrorSchema } from '../lib/api-contracts.js'
import { CSRF_HEADER_NAME, isRejectedByCsrfToken } from '../lib/csrf.js'
import { operationalLog } from '../lib/logger.js'
import { secureRoute, type SecureRouteContext } from '../lib/secure-route.js'
import { env } from '../config/env.js'
import {
  isUiPanelCapabilityDeclared,
  renderExtensionPanel,
  resolveExtensionNavItems,
  resolveKnownUiPanelSlots,
} from '../lib/extension-panel.js'
import {
  handleModuleAction,
  type ModuleActionOutcome,
  type ModuleActionRequestBody,
} from '../lib/module-action-handler.js'
import { getExtensionStatus } from './loader.js'

const ExtensionPanelParamsSchema = z.object({ slot: z.string() })

/**
 * Story 25.3 AC2/AC5/Task 3 — the OpenAPI-facing shape (regenerated into
 * `packages/shared/openapi.json`). Deliberately permissive (plain optional strings, no
 * regex/format constraint) rather than encoding AC2/AC5's bounded patterns here: this app's
 * global Fastify/Zod validator rejects a schema-level format failure with an opaque 500
 * ("Unhandled request error"), not the `400` AC2/AC5 both specify. Actual shape enforcement is
 * the MANUAL `isMalformedQueryValue()` check below, mirroring `slot`'s own existing
 * pre-hook-call validation discipline (a manual check inside the handler, not a framework-level
 * one) — that is what produces the real `400` before any DB lookup.
 */
const ExtensionPanelQuerySchema = z.object({
  projectId: z.string().optional(),
  resourceId: z.string().optional(),
  // Story 25.8 AC1/Task 1 — same OpenAPI-permissive-shape rationale as projectId/resourceId
  // above: actual shape enforcement is `isMalformedQueryValue()`'s manual `SUBPATH_PATTERN`
  // check below (a 400, not the global validator's opaque 500).
  subpath: z.string().optional(),
})

const PROJECT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
// Story 25.8 AC1/Task 1 — mirrors RESOURCE_ID_PATTERN's charset per path segment (bounded,
// alphanumeric/dash/underscore only — never `.`/`..`, which rules out a path-traversal-shaped
// value by construction) but allows `/`-separated segments, since a sub-path is inherently
// multi-segment (e.g. `groups/123/detail`). No leading/trailing/doubled slash (each of those
// would otherwise produce an empty segment). Bounded to 256 chars total — generous for a
// sub-path, short enough not to be a DoS vector.
// eslint-disable-next-line security/detect-unsafe-regex -- no catastrophic-backtracking risk: the per-segment charset ([A-Za-z0-9_-]) never overlaps with the `/` separator, so there is no ambiguous match to backtrack over; length is also bounded to SUBPATH_MAX_LENGTH before this pattern ever runs (isMalformedQueryValue below).
const SUBPATH_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/
const SUBPATH_MAX_LENGTH = 256

function isMalformedQueryValue(query: {
  projectId?: string
  resourceId?: string
  subpath?: string
}): boolean {
  if (query.projectId !== undefined && !PROJECT_ID_PATTERN.test(query.projectId)) return true
  if (query.resourceId !== undefined && !RESOURCE_ID_PATTERN.test(query.resourceId)) return true
  if (query.subpath !== undefined) {
    if (query.subpath.length > SUBPATH_MAX_LENGTH) return true
    if (!SUBPATH_PATTERN.test(query.subpath)) return true
  }
  return false
}

/**
 * Shared by both `/extensions/panels/:slot` (GET) and `/extensions/panels/:slot/actions` (POST)
 * — AC2/AC5's manual shape-validation-before-any-DB-lookup discipline applies identically to
 * both routes. Returns `undefined` after already sending the 400 itself, so a handler can just
 * early-return on that.
 */
function parsePanelSlotAndQueryOrReject(
  req: FastifyRequest,
  reply: FastifyReply
): { slot: string; projectId?: string; resourceId?: string; subpath?: string } | undefined {
  const { slot } = req.params as { slot: string }
  const { projectId, resourceId, subpath } = req.query as {
    projectId?: string
    resourceId?: string
    subpath?: string
  }
  if (isMalformedQueryValue({ projectId, resourceId, subpath })) {
    reply
      .status(400)
      .send({ code: 'invalid_query', message: 'Malformed projectId, resourceId, or subpath' })
    return undefined
  }
  return { slot, projectId, resourceId, subpath }
}

const ExtensionPanelOkSchema = z.object({
  ok: z.literal(true),
  html: z.string(),
  // Story 25.5 AC4/Task 4: present only when the loaded extension declares moduleActions for
  // this slot — omitted entirely (never an empty string) when it does not, so apps/web can
  // conditionally widen EXTENSION_PANEL_CSP's connect-src only for action-capable panels.
  actionEndpoint: z.string().optional(),
})
const ExtensionPanelUnavailableSchema = z.object({
  ok: z.literal(false),
  reason: z.literal('panel_unavailable'),
})

/**
 * Story 25.5 AC1/AC5/Task 5 — the OpenAPI-facing shapes for `POST /extensions/panels/:slot/actions`
 * (regenerated into `packages/shared/openapi.json`). Mirrors `ExtensionPanelOkSchema`/
 * `ExtensionPanelUnavailableSchema`'s existing pattern, but the success shape is deliberately NOT
 * wrapped in `{ ok: true, ... }` the way the GET panel route is — CM's real, already-shipped
 * `replaceWithResponse(root, payload)` (see this story's Finding) reads the JSON body directly as
 * `{ html }` or `{ message }`, not through an `ok`/`reason` envelope; PV conforms to that existing
 * wire shape rather than inventing its own (matching Elicitation Log #4's own precedent).
 */
const ExtensionActionOkSchema = z.object({
  html: z.string().optional(),
  message: z.string().optional(),
})

const ExtensionActionQuerySchema = z.object({
  projectId: z.string().optional(),
  resourceId: z.string().optional(),
})

/**
 * Story 25.5 Task 3 — shape-validated BEFORE any DB lookup or `onAction()` call: a JSON object
 * with a non-empty, length-bounded string `kind` field. Anything else 400s here, mirroring
 * `isMalformedQueryValue`'s own pre-hook-call validation position (a manual check, not a
 * framework-level `schema.body`, since this app's global Zod validator would otherwise reject a
 * shape failure with an opaque 500 rather than this route's own controlled 400 — same rationale
 * `ExtensionPanelQuerySchema`'s own comment documents).
 */
const MAX_ACTION_KIND_LENGTH = 128

function extractValidActionBody(body: unknown): ModuleActionRequestBody | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const candidate = body as Record<string, unknown>
  if (
    typeof candidate['kind'] !== 'string' ||
    candidate['kind'].length === 0 ||
    candidate['kind'].length > MAX_ACTION_KIND_LENGTH
  ) {
    return undefined
  }
  return candidate as ModuleActionRequestBody
}

/**
 * Story 25.5 Task 2/Open Design Question 1 (Option B, human sign-off 2026-08-24) — defense-in-depth
 * on top of the existing CORS-allowlist + JSON-content-type baseline, NOT a replacement for Story
 * 25.6's real CSRF token. `Sec-Fetch-Site` is browser-supplied and unspoofable by page JS; any
 * value other than `'same-origin'` is rejected. A REQUEST MISSING THE HEADER ENTIRELY (older
 * browsers that predate the Fetch Metadata spec) is treated as a pass-through, not a rejection —
 * per the resolved decision, this must never break a non-Fetch-Metadata-capable browser outright.
 */
function isRejectedBySecFetchSite(header: string | string[] | undefined): boolean {
  if (header === undefined) return false
  const value = Array.isArray(header) ? header[0] : header
  return value !== 'same-origin'
}

/**
 * Story 25.5 AC5 — the fixed `ActionResult`/host-precheck outcome → HTTP-status mapping. No
 * outcome ever forwards the extension's own thrown error text, DB error detail, or stack trace —
 * `handleModuleAction()` has already reduced any such detail to a fixed-enum operational log
 * entry (`EXTENSION_MODULE_ACTION_FAILED`) before this function is ever called. `denied`'s own
 * `message` (if the extension supplied one) is deliberately NEVER forwarded here, unlike
 * `validation_failed`/`conflict` — a denial reason is exactly the kind of detail this codebase's
 * existing discipline says must not leak (mirrors `renderExtensionPanel()`'s own
 * `panel_unavailable` non-distinguishing convention for a project-visibility denial).
 */
function moduleActionOkResponse(result: Extract<ModuleActionOutcome, { outcome: 'ok' }>): {
  status: number
  body: Record<string, unknown>
} {
  return {
    status: 200,
    body: {
      ...(result.html !== undefined ? { html: result.html } : {}),
      ...(result.message !== undefined ? { message: result.message } : {}),
    },
  }
}

/** Fixed, non-`ok` host-precheck/`ActionResult` outcomes — table lookup, not a branching
 * function, to keep `mapModuleActionOutcomeToResponse`'s cyclomatic complexity within this
 * repo's lint budget while preserving the exact same AC5 status mapping. */
const FIXED_STATUS_BY_OUTCOME = {
  invalid_slot: { status: 400, code: 'invalid_slot', message: 'Unknown or malformed panel slot' },
  not_found: { status: 404, code: 'action_not_found', message: 'Action not found' },
  denied: { status: 403, code: 'denied', message: 'Request denied' },
  error: { status: 500, code: 'internal_error', message: 'Request failed' },
} as const

function mapModuleActionOutcomeToResponse(result: ModuleActionOutcome): {
  status: number
  body: Record<string, unknown>
} {
  if (result.outcome === 'ok') return moduleActionOkResponse(result)

  // AC5: `validation_failed`/`conflict` forward the extension's own `message` verbatim
  // (deliberately — CM's real `dispatch()` displays it in its `aria-live` region, and it is
  // by construction meant to be user-facing). Every other outcome uses a fixed generic message
  // that never depends on anything extension-supplied.
  if (result.outcome === 'validation_failed') {
    return { status: 400, body: { code: 'validation_failed', message: result.message } }
  }
  if (result.outcome === 'conflict') {
    return { status: 409, body: { code: 'conflict', message: result.message ?? 'Conflict' } }
  }

  const fixed = FIXED_STATUS_BY_OUTCOME[result.outcome]
  return { status: fixed.status, body: { code: fixed.code, message: fixed.message } }
}

/**
 * Story 29.3 AC1/AC9 — the OpenAPI-facing shape for one manifest-declared `navItems` entry.
 * Mirrors `ExtensionNavItem` (`@project-vault/extension-api`) exactly; `icon` is deliberately a
 * plain optional string here (not a literal-union enum) for the same reason
 * `ExtensionPanelQuerySchema`'s own comment documents — this app's global Zod validator rejects a
 * schema-level format failure with an opaque 500, not a controlled 400/response-shape mismatch;
 * actual token validation already happened at `registerExtension()` time (AC6), so by the time a
 * value reaches this schema it is trusted.
 */
const ExtensionNavItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  href: z.string(),
  icon: z.string().optional(),
  parentId: z.string().optional(),
})

const ExtensionNavSchema = z.object({
  // Story 25.1 AC5: `null` when no nav entry should be shown at all (no extension loaded, or the
  // loaded extension does not declare the `'ui-panel'` capability) — never a dead link by
  // default. Story 25.2 AC5: a non-null value is the FIRST entry of the dynamically resolved
  // known-slots list (`resolveKnownUiPanelSlots(status)[0]`) — still exactly one slot reported;
  // enumerating multiple nav entries per declared slot is deferred to Story 25.8.
  uiPanelSlot: z.string().nullable(),
  // Story 29.3 AC9 — ALWAYS present ([] when none declared or no extension loaded, never
  // undefined) — an empty nav-items list is a completely ordinary, non-degraded state, unlike
  // `actionEndpoint`'s "present only when applicable" convention. Resolved independently of
  // `uiPanelSlot`/the `'ui-panel'` capability (AC1's independence decision) — never gated behind
  // either.
  navItems: z.array(ExtensionNavItemSchema),
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
      querystring: ExtensionPanelQuerySchema,
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
    handler: async (ctx, req: FastifyRequest, reply) => {
      // AC2/AC5: shape-validated BEFORE any DB lookup — the exact same pre-hook-call validation
      // position `slot` itself uses.
      const parsed = parsePanelSlotAndQueryOrReject(req, reply)
      if (!parsed) return reply
      const { slot, projectId, resourceId, subpath } = parsed
      const secureCtx = ctx as SecureRouteContext
      // Story 25.2 AC3: resolved fresh from getExtensionStatus() on every request, never a
      // module-level constant — a slot the currently loaded extension's manifest doesn't
      // declare 400s here even if the hook itself would have handled it gracefully.
      const knownSlots = resolveKnownUiPanelSlots(getExtensionStatus(), req.log)
      // Story 25.3 AC1: identity/orgId are read directly from THIS request's own resolved
      // `secureCtx.auth` — never from a client body/query/header, never memoized from an earlier
      // call. AC2/AC5: `projectId`/`resourceId` are already shape-validated above by the time
      // they reach here.
      const result = await renderExtensionPanel(
        slot,
        knownSlots,
        req.log,
        {
          userId: secureCtx.auth.userId,
          orgId: secureCtx.auth.orgId,
          orgRole: secureCtx.auth.orgRole,
        },
        secureCtx.tx,
        { projectId, resourceId, subpath }
      )

      if (result.outcome === 'invalid_slot') {
        return reply
          .status(400)
          .send({ code: 'invalid_slot', message: 'Unknown or malformed panel slot' })
      }
      if (result.outcome === 'unavailable') {
        return { ok: false as const, reason: 'panel_unavailable' as const }
      }
      return {
        ok: true as const,
        html: result.html,
        ...(result.actionEndpoint !== undefined ? { actionEndpoint: result.actionEndpoint } : {}),
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/extensions/panels/:slot/actions',
    schema: {
      params: ExtensionPanelParamsSchema,
      querystring: ExtensionActionQuerySchema,
      response: {
        200: ExtensionActionOkSchema,
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        429: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    security: {
      // AC1/AC3: same any-active-org-member security profile as the GET panel route — identity/
      // org come from `request.authContext` (resolved by secureRoute() from the session cookie),
      // never from the request body, query, or headers.
      requireAuth: true,
      writeAuditEvent: false,
      // Story 25.5 AC6/Task 3 — 30 actions/minute/user. This route is a genuinely new,
      // authenticated MUTATION surface with no purpose-built CSRF defense yet (Story 25.6, not
      // this story's job — see Open Design Question 1); the Security Audit Personas elicitation
      // round's own finding was that an authenticated user hammering a mutation route with ZERO
      // rate limiting is a materially worse gap than an imperfectly-tuned limit. 30/min is
      // generous for legitimate interactive use (a human clicking buttons in a panel) while
      // bounding the cost of a compromised/malicious same-origin caller looping requests — an
      // interim, conservative default per AC6, not Story 25.7's eventual formalized policy.
      rateLimit: { max: 30, timeWindowMs: 60_000, key: 'POST /extensions/panels/:slot/actions' },
    },
    handler: async (ctx, req: FastifyRequest, reply) => {
      const parsed = parsePanelSlotAndQueryOrReject(req, reply)
      if (!parsed) return reply
      const { slot, projectId, resourceId } = parsed

      // Task 2/Open Design Question 1 (Option B, resolved 2026-08-24) — defense-in-depth on top
      // of the existing CORS-allowlist + JSON-content-type baseline, checked before any DB
      // lookup or hook invocation.
      if (isRejectedBySecFetchSite(req.headers['sec-fetch-site'])) {
        return reply.status(403).send({ code: 'denied', message: 'Request rejected' })
      }

      // Story 25.6 AC1/AC2/AC4 — the real CSRF token check, at the exact same early position as
      // the Sec-Fetch-Site check above (Dev Notes cross-reference): before any DB lookup or
      // `handleModuleAction()`/`onAction()` call. Double-submit-cookie pattern (Task 1) — the
      // client (`+page.svelte`'s postMessage-relay fetch, AC5) must echo the CSRF cookie's own
      // value back as the `x-csrf-token` header. Detail is never leaked to the client (AC4) —
      // only a fixed generic message, with the real failure logged server-side only via the same
      // fixed-enum `EXTENSION_MODULE_ACTION_FAILED`/subReason discipline
      // `logModuleActionFailed()` already established for every other action-route failure path.
      // eslint-disable-next-line security/detect-object-injection -- CSRF_HEADER_NAME is a fixed, hardcoded string constant ('x-csrf-token'), never user input.
      if (isRejectedByCsrfToken(req.cookies, req.headers[CSRF_HEADER_NAME], env.COOKIE_SECURE)) {
        operationalLog(
          req.log,
          'error',
          OperationalEvent.EXTENSION_MODULE_ACTION_FAILED,
          'Extension module action failed',
          { slot, actionKind: 'unknown', subReason: 'csrf_rejected' }
        )
        return reply.status(403).send({ code: 'csrf_rejected', message: 'Request rejected' })
      }

      const action = extractValidActionBody(req.body)
      if (!action) {
        return reply.status(400).send({
          code: 'invalid_action',
          message: 'Request body must include a string "kind" field',
        })
      }

      const secureCtx = ctx as SecureRouteContext
      const knownSlots = resolveKnownUiPanelSlots(getExtensionStatus(), req.log)
      // AC3: identity/orgId are read directly from THIS request's own resolved `secureCtx.auth`
      // — never from `action` (the client-supplied body), never memoized from an earlier call.
      const result = await handleModuleAction(
        { slot, knownSlots },
        req.log,
        {
          userId: secureCtx.auth.userId,
          orgId: secureCtx.auth.orgId,
          orgRole: secureCtx.auth.orgRole,
        },
        secureCtx.tx,
        action,
        { projectId, resourceId }
      )

      const { status, body } = mapModuleActionOutcomeToResponse(result)
      return reply.status(status).send(body)
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
      // Story 29.3 AC9: resolved unconditionally, independent of isUiPanelCapabilityDeclared() —
      // navItems is never gated behind the 'ui-panel' capability (AC1).
      const navItems = resolveExtensionNavItems(getExtensionStatus(), req.log)
      return { uiPanelSlot: isUiPanelCapabilityDeclared() ? knownSlots[0] : null, navItems }
    },
  })
}
