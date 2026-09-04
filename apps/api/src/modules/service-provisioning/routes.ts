import { randomUUID } from 'node:crypto'
import type { ZodType } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import type { BossService } from '../../lib/boss.js'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { isRateLimitEnforced, validationError } from '../../lib/route-helpers.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { timingSafeHeaderTokenMatches } from '../../lib/timing-safe-header-token.js'
import { operationalLog, serializeLogError } from '../../lib/logger.js'
import { revokeAllSessionsForOrg } from '../auth/session-revoke.js'
import {
  backfillCentralizemeOrgLink,
  provisionServiceOrganization,
  provisionServiceOrgMember,
  resolveOrgByCentralizemeId,
  ServiceProvisioningForbiddenError,
  serviceOrgNotFound,
  ServiceRevocationForbiddenError,
} from './service.js'
import {
  BackfillCentralizemeOrgLinkParamsSchema,
  BackfillCentralizemeOrgLinkRequestSchema,
  BackfillCentralizemeOrgLinkResponseSchema,
  ProvisionServiceOrganizationRequestSchema,
  ProvisionServiceOrgMemberParamsSchema,
  ProvisionServiceOrgMemberRequestSchema,
  ProvisionServiceOrgMemberResponseSchema,
  RevokeOrgSessionsParamsSchema,
  RevokeOrgSessionsRequestSchema,
  RevokeOrgSessionsResponseSchema,
} from './schema.js'
import { createAdminAlert, deliverAdminAlertToPlatformOperator } from '../backup/alerts.js'

type BossFastify = FastifyApp & { boss?: BossService }

const ORG_SESSIONS_REVOKED_ALERT_TYPE = 'org.sessions_revoked_by_service'

type FastifyRequestHeaders = Record<string, string | string[] | undefined>

/**
 * Story 26.1 AC-2/AC-7/AC-8: a static, timing-safe-compared shared secret, never a human session,
 * never secureRoute()'s org-authenticated path — same convention as
 * apps/api/src/modules/vault/key-service.ts's assertBootstrapAuthorized(), which shares this
 * check's constant-time comparison via lib/timing-safe-header-token.js. Fail-closed when
 * SERVICE_PROVISIONING_TOKEN is unset (route is unreachable for every request, same 403 as an
 * invalid token — never distinguishable from "missing vs wrong").
 */
function assertServiceProvisioningAuthorized(headers: FastifyRequestHeaders): void {
  const token = env.SERVICE_PROVISIONING_TOKEN
  if (!token) throw new ServiceProvisioningForbiddenError()

  if (!timingSafeHeaderTokenMatches(headers, 'x-service-provisioning-token', token)) {
    throw new ServiceProvisioningForbiddenError()
  }
}

/**
 * Story 31.1 (DW-130) Decision 1/AC1.2/AC1.3/AC1.4/AC1.5: the exact same pattern as
 * assertServiceProvisioningAuthorized above, against a DEDICATED, never-shared secret
 * (SERVICE_REVOCATION_TOKEN — see env.ts's validateServiceRevocationTokenProductionSecret). Fail-
 * closed when unset; timingSafeHeaderTokenMatches already handles the length-mismatch case
 * before ever calling timingSafeEqual (AC1.5) — no second length check is added here.
 */
function assertServiceRevocationAuthorized(headers: FastifyRequestHeaders): void {
  const token = env.SERVICE_REVOCATION_TOKEN
  if (!token) throw new ServiceRevocationForbiddenError()

  if (!timingSafeHeaderTokenMatches(headers, 'x-service-revocation-token', token)) {
    throw new ServiceRevocationForbiddenError()
  }
}

function sendAppError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({ code: err.code, message: err.message })
  }
  throw err
}

/**
 * Shared "check the static service token, 403 via sendAppError otherwise" guard used by every
 * route handler in this module — factored out after a jscpd duplication finding on this exact
 * try/catch across the per-member and backfill routes. Returns true iff authorized (caller should
 * `return` immediately when false; the 403 reply has already been sent).
 */
function authorizeOrReply(
  reply: FastifyReply,
  headers: FastifyRequestHeaders,
  assertAuthorized: (headers: FastifyRequestHeaders) => void
): boolean {
  try {
    assertAuthorized(headers)
    return true
  } catch (err) {
    sendAppError(reply, err)
    return false
  }
}

/**
 * Shared "safeParse or reply 422" helper used by every route handler in this module that
 * schema-validates params/body itself (attachValidation: true routes) — factored out after a
 * jscpd duplication finding on this exact pattern across the per-member and backfill routes.
 * Returns the parsed data, or `undefined` when validation failed (the 422 reply has already been
 * sent; caller should `return` immediately).
 */
function parseOrReply<T>(
  reply: FastifyReply,
  schema: ZodType<T>,
  data: unknown,
  part: 'params' | 'body'
): T | undefined {
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, part))
    return undefined
  }
  return parsed.data
}

/**
 * Story 31.1 (DW-130) Decision 5/AC14.46/AC14.47 — fires a real-time operator-facing alert on
 * EVERY successful call to the revocation route (even at zero counts), reusing this codebase's
 * existing operational-event/notification mechanism (createAdminAlert +
 * deliverAdminAlertToPlatformOperator) rather than inventing a new delivery path. Deliberately NOT
 * deduped (createAdminAlert, not createAdminAlertIfNotActive) — every call is its own forensically
 * significant event, mirroring AC7.25's audit-write-always-even-at-zero-counts convention.
 *
 * AC14.46 requires this alert be "addressed to platform operators (not the org's own admins —
 * this is a machine-to-machine platform action, not a user-facing one)". `deliverAdminAlertAcrossOrgs`
 * (Story 9.1's backup-failure/FR109 key-custody precedent) is the wrong tool here: it delivers to
 * EVERY org's own admin group, which for this org-specific event would leak one tenant's
 * orgId/centralizemeOrganizationId/counts/requestId to every unrelated org's admins.
 * `deliverAdminAlertToPlatformOperator` instead targets only the instance's single platform
 * operator (apps/api/src/modules/backup/alerts.ts).
 *
 * AC14.47: a dispatch failure here must NEVER fail the response or roll back an otherwise-
 * successful revocation — the alert is a detection aid, not a correctness gate (deliberate
 * asymmetry with AC7.27's audit-write rollback). Logged and swallowed.
 */
async function dispatchOrgSessionsRevokedAlert(
  boss: BossService | undefined,
  logger: Parameters<typeof operationalLog>[0],
  input: {
    organizationId: string
    centralizemeOrganizationId: string
    sessionsRevokedCount: number
    apiKeysRevokedCount: number
    requestId: string
  }
): Promise<void> {
  try {
    await createAdminAlert({
      alertType: ORG_SESSIONS_REVOKED_ALERT_TYPE,
      severity: 'warning',
      payload: { ...input, alertInstanceId: randomUUID() },
    })
    if (boss) {
      await deliverAdminAlertToPlatformOperator(
        boss,
        ORG_SESSIONS_REVOKED_ALERT_TYPE,
        input,
        'warning'
      )
    }
  } catch (error) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.ORG_SESSIONS_REVOKED_ALERT_DISPATCH_FAILED,
      'org-sessions-revoked-by-service alert dispatch failed',
      { organizationId: input.organizationId, err: serializeLogError(error) }
    )
  }
}

export async function serviceProvisioningRoutes(fastify: FastifyApp): Promise<void> {
  // Story 31.1 (DW-130) Decision 5/AC8.28/AC14.45: @fastify/rate-limit must actually be
  // registered somewhere for a route's `config: { rateLimit: {...} }` to have any effect at all
  // — mirrors auth/routes.ts's own per-module registration (this module's provisioning route
  // above stays unaffected via its own `rateLimit: false`). Same isRateLimitEnforced() test-bypass
  // convention as authRoutes: real request-rate buckets are wall-clock-based, so integration
  // tests unrelated to rate limiting itself skip registration by default
  // (RATE_LIMIT_TEST_BYPASS=true); a test that wants to exercise real enforcement sets it false.
  if (isRateLimitEnforced()) {
    await fastify.register(rateLimit, {
      max: 30,
      timeWindow: '1 minute',
      errorResponseBuilder: (_req: FastifyRequest, context: { statusCode: number }) => ({
        statusCode: context.statusCode,
        code: 'rate_limit_exceeded',
        message: 'Too many requests',
      }),
    })
  }

  fastify.route({
    method: 'POST',
    url: '/api/v1/service/organizations',
    // Story 26.1 AC-2: never rate-limited via the human-facing auth rate limiter — this route has
    // its own auth mechanism entirely (static token), not subject to per-IP registration limits.
    config: { rateLimit: false },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (
        !authorizeOrReply(
          reply,
          req.headers as FastifyRequestHeaders,
          assertServiceProvisioningAuthorized
        )
      )
        return

      const parsed = parseOrReply(
        reply,
        ProvisionServiceOrganizationRequestSchema,
        req.body,
        'body'
      )
      if (!parsed) return

      const result = await provisionServiceOrganization(parsed)
      return reply.status(201).send({
        data: {
          organizationId: result.organizationId,
          userId: result.userId,
          externalIdentityId: result.externalIdentityId,
        },
      })
    },
  })

  // Story 32.1: machine-authenticated per-member provisioning on an EXISTING organization —
  // extends the org-bootstrap route above with a second, per-member route in the same module
  // (Decision 1). Registered via fastify.route() directly, same auth mechanism
  // (assertServiceProvisioningAuthorized, Decision 3: reuse SERVICE_PROVISIONING_TOKEN, no new
  // secret), same "never rate-limited via the human-facing limiter" convention as the org route.
  fastify.route({
    method: 'POST',
    url: '/api/v1/service/organizations/:organizationId/members',
    config: { rateLimit: false },
    attachValidation: true,
    schema: {
      params: ProvisionServiceOrgMemberParamsSchema,
      body: ProvisionServiceOrgMemberRequestSchema,
      response: {
        200: ProvisionServiceOrgMemberResponseSchema,
        201: ProvisionServiceOrgMemberResponseSchema,
        400: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (
        !authorizeOrReply(
          reply,
          req.headers as FastifyRequestHeaders,
          assertServiceProvisioningAuthorized
        )
      )
        return

      const parsedParams = parseOrReply(
        reply,
        ProvisionServiceOrgMemberParamsSchema,
        req.params,
        'params'
      )
      if (!parsedParams) return

      const parsedBody = parseOrReply(
        reply,
        ProvisionServiceOrgMemberRequestSchema,
        req.body,
        'body'
      )
      if (!parsedBody) return

      try {
        const result = await provisionServiceOrgMember(parsedParams.organizationId, parsedBody)
        return reply.status(result.created ? 201 : 200).send({
          data: { userId: result.userId, externalIdentityId: result.externalIdentityId },
        })
      } catch (err) {
        return sendAppError(reply, err)
      }
    },
  })

  // Story 31.1 (DW-130): machine-authenticated, org-wide handoff-session (+ machine-user API key)
  // revocation — see the story's Decisions 1-6 for the full rationale. Registered via
  // fastify.route() directly (never secureRoute()) for the same reason as the provisioning route
  // above: there is no PV session to authenticate.
  fastify.route({
    method: 'POST',
    url: '/api/v1/service/organizations/:centralizemeOrganizationId/revoke-sessions',
    // Decision 5/AC8.28/AC14.45: unlike the provisioning route above, this route DOES get a rate
    // limit — a coarse, route-WIDE (not per-IP, not per-org) cap via a constant keyGenerator, so
    // it applies as a single shared budget regardless of caller IP. Generous enough that no
    // legitimate CM bulk-deprovisioning workload will ever hit it; exists to bound how fast a
    // leaked-token blast radius (Decision 5, Finding 2) can be exploited, not to defend against
    // brute-forcing the secret itself.
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: () => 'service-revoke-sessions',
      },
    },
    // Mirrors /auth/register and /auth/login's convention: the handler re-validates params/body
    // itself via safeParse and replies with this codebase's universal 422 { code, message,
    // details } envelope — attachValidation defers fastify's own auto-validation/auto-reply so
    // that manual handling wins, instead of the framework's raw (non-422, differently-shaped)
    // validation-failure response.
    attachValidation: true,
    schema: {
      params: RevokeOrgSessionsParamsSchema,
      body: RevokeOrgSessionsRequestSchema,
      response: {
        200: RevokeOrgSessionsResponseSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (
        !authorizeOrReply(
          reply,
          req.headers as FastifyRequestHeaders,
          assertServiceRevocationAuthorized
        )
      )
        return

      const parsedParams = parseOrReply(reply, RevokeOrgSessionsParamsSchema, req.params, 'params')
      if (!parsedParams) return

      // AC5.19: `.strict()` on RevokeOrgSessionsRequestSchema rejects any unexpected body field
      // (e.g. a caller-supplied `orgId` attempting to widen scope) with 422.
      const parsedBody = parseOrReply(reply, RevokeOrgSessionsRequestSchema, req.body, 'body')
      if (!parsedBody) return

      const orgId = await resolveOrgByCentralizemeId(parsedParams.centralizemeOrganizationId)
      if (!orgId) {
        const notFound = serviceOrgNotFound()
        return reply.status(notFound.statusCode).send({
          code: notFound.code,
          message: notFound.message,
        })
      }

      const result = await revokeAllSessionsForOrg({
        orgId,
        requestId: parsedBody.requestId,
      })

      await dispatchOrgSessionsRevokedAlert((fastify as BossFastify).boss, req.log, {
        organizationId: orgId,
        centralizemeOrganizationId: parsedParams.centralizemeOrganizationId,
        sessionsRevokedCount: result.sessionsRevokedCount,
        apiKeysRevokedCount: result.apiKeysRevokedCount,
        requestId: parsedBody.requestId,
      })

      return reply.status(200).send({
        data: {
          organizationId: orgId,
          sessionsRevokedCount: result.sessionsRevokedCount,
          apiKeysRevokedCount: result.apiKeysRevokedCount,
          requestId: parsedBody.requestId,
        },
      })
    },
  })

  // Story 33.1 (DW-256): machine-authenticated backfill of
  // organizations.centralizeme_organization_id for a pre-existing organization — extends this
  // same module with a fourth route (Decision 1). Same auth mechanism/no-new-secret convention
  // (assertServiceProvisioningAuthorized, SERVICE_PROVISIONING_TOKEN) and same
  // `rateLimit: false` provisioning-class convention as the org-bootstrap/per-member routes above
  // (not 31.1's rate-limited revocation route) — see the story's Security section for why.
  fastify.route({
    method: 'PATCH',
    url: '/api/v1/service/organizations/:organizationId/centralizeme-link',
    config: { rateLimit: false },
    attachValidation: true,
    schema: {
      params: BackfillCentralizemeOrgLinkParamsSchema,
      body: BackfillCentralizemeOrgLinkRequestSchema,
      response: {
        200: BackfillCentralizemeOrgLinkResponseSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (
        !authorizeOrReply(
          reply,
          req.headers as FastifyRequestHeaders,
          assertServiceProvisioningAuthorized
        )
      )
        return

      const parsedParams = parseOrReply(
        reply,
        BackfillCentralizemeOrgLinkParamsSchema,
        req.params,
        'params'
      )
      if (!parsedParams) return

      const parsedBody = parseOrReply(
        reply,
        BackfillCentralizemeOrgLinkRequestSchema,
        req.body,
        'body'
      )
      if (!parsedBody) return

      try {
        const result = await backfillCentralizemeOrgLink(parsedParams.organizationId, parsedBody)
        return reply.status(200).send({
          data: {
            organizationId: result.organizationId,
            centralizemeOrganizationId: result.centralizemeOrganizationId,
            alreadyLinked: result.alreadyLinked,
            dryRun: result.dryRun,
          },
        })
      } catch (err) {
        return sendAppError(reply, err)
      }
    },
  })
}
