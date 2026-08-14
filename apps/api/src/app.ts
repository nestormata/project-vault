import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod'
import swaggerUi from '@fastify/swagger-ui'
import { healthRoutes } from './routes/health.js'
import { statusRoutes } from './routes/status.js'
import { metricsRoutes } from './routes/metrics.js'
import { openapiRoutes } from './routes/openapi.js'
import { docsEnabled } from './lib/docs-gating.js'
import { vaultRoutes } from './modules/vault/routes.js'
import { authRoutes } from './modules/auth/routes.js'
import { orgRoutes } from './modules/org/routes.js'
import { auditRoutes } from './modules/audit/routes.js'
import { projectRoutes } from './modules/projects/routes.js'
import { projectInvitationRoutes } from './modules/invitations/routes.js'
import { invitationTokenRoutes } from './modules/invitations/token-routes.js'
import { credentialRoutes } from './modules/credentials/routes.js'
import { rotationRoutes } from './modules/rotation/routes.js'
import { credentialSharesRoutes } from './modules/credential-shares/routes.js'
import { credentialShareAccessRoutes } from './modules/credential-shares/access-routes.js'
import { externalCredentialShareAccessRoutes } from './modules/credential-shares/external-access-routes.js'
import { monitoringRoutes } from './modules/monitoring/routes.js'
import { healthDashboardRoutes } from './modules/monitoring/health-dashboard-routes.js'
import { statusPageRoutes } from './modules/monitoring/status-page-routes.js'
import { publicStatusPageRoutes } from './modules/monitoring/public-status-page-routes.js'
import { onboardingRoutes } from './modules/onboarding/routes.js'
import { usersRoutes } from './modules/users/routes.js'
import { searchRoutes } from './modules/search/routes.js'
import { dashboardRoutes } from './modules/dashboard/routes.js'
import { adminRoutes } from './modules/admin/routes.js'
import { backupRoutes } from './modules/backup/routes.js'
import { settingsRoutes } from './modules/platform-admin/settings-routes.js'
import { orgsRoutes } from './modules/platform-admin/orgs-routes.js'
import { resourceUsageRoutes } from './modules/platform-admin/resource-usage-routes.js'
import { statusTokenRoutes } from './modules/platform-admin/status-token-routes.js'
import { platformAuditRoutes } from './modules/platform-audit/routes.js'
import { notificationRoutes } from './modules/notifications/routes.js'
import { machineUserRoutes } from './modules/machine-users/routes.js'
import { machineTokenExchangeRoutes } from './modules/machine-users/token-exchange-routes.js'
import { machineCredentialRoutes } from './modules/machine-users/machine-credential-routes.js'
import { cacheActivatedRoutes } from './modules/machine-users/cache-activated-routes.js'
import { securityAlertActionsRoutes } from './modules/org/security-alert-actions-routes.js'
import { organizationSettingsRoutes } from './modules/org/organization-settings-routes.js'
import { erasureRoutes } from './modules/compliance/erasure-routes.js'
import { extensionStatusRoutes } from './extensions/status-routes.js'
import { loadExtension, getExtensionStatus } from './extensions/loader.js'
import { themingRoutes } from './modules/theming/routes.js'
import { themeSelectionRoutes } from './modules/theming/selection-routes.js'
import { reloadThemesWithFanout } from './modules/theming/service.js'
import { wireExtensionAuthStrategy } from './modules/auth/strategies.js'
import { ssoRoutes } from './modules/auth/sso-routes.js'
import { domainLookupRoutes } from './modules/auth/domain-lookup-routes.js'
import { orgSsoDomainsRoutes } from './modules/auth/org-sso-domains-routes.js'
import { externalIdentityRoutes } from './modules/auth/external-identity-routes.js'
import { vaultGuardPlugin } from './plugins/vault-guard.js'
import { jwtPlugin } from './plugins/jwt.js'
import { machineJwtPlugin } from './plugins/machine-jwt.js'
import authenticatePlugin from './plugins/authenticate.js'
import { structuredLoggingPlugin } from './plugins/structured-logging.js'
import { httpMetricsPlugin } from './plugins/http-metrics.js'
import { createLoggerConfig, serializeLogError } from './lib/logger.js'
import { env } from './config/env.js'
import { AppError } from './lib/errors.js'
import type { FastifyApp } from './lib/fastify-app.js'
import { getReleaseVersion } from './lib/package-version.js'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyRequest } from 'fastify'

// RFC 4122 UUID v4: version nibble = 4, variant nibble ∈ {8,9,a,b}. Do NOT loosen
// this regex — nil UUID and non-v4 formats are intentionally rejected so a caller
// cannot inject arbitrary trace-correlation strings via X-Request-ID.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type DbPool = {
  query: (sql: string) => Promise<unknown>
}

export type AppOptions = {
  dbPool?: DbPool
  logger?: boolean | object
  metricsBindHost?: string
  vaultGuardEnabled?: boolean
}

function shouldNormalizeMfaParserError(
  url: string,
  statusCode: number | undefined,
  parserErrorCode: string | undefined
): boolean {
  const path = url.split('?')[0]
  return (
    path === '/api/v1/auth/mfa/verify-login' &&
    (statusCode === 413 ||
      statusCode === 415 ||
      parserErrorCode === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
      parserErrorCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
  )
}

export async function createApp(options: AppOptions = {}): Promise<FastifyApp> {
  // Story 9.10 AC-1: read fresh on every createApp() call (not cached at module load) — the
  // env var is fixed for the life of a real process, but reading it here (rather than at
  // import time) keeps this in sync with any test/harness that sets RELEASE_VERSION per call,
  // with zero behavioral difference for a real deployment.
  const API_VERSION = getReleaseVersion().version

  let logger: boolean | object
  if (options.logger === false) {
    logger = false
  } else if (options.logger !== undefined) {
    logger = options.logger
  } else {
    logger = createLoggerConfig(env)
  }

  // ignoreTrailingSlash: Fastify's router treats "/health" and "/health/" as distinct
  // routes by default, which would 404 before the vault guard's own normalizePath() ever
  // runs (AC-5 requires /health/ to behave identically to /health while sealed).
  const fastify: FastifyApp = Fastify({
    logger,
    // Disable Fastify's blind header trust; genReqId validates X-Request-ID itself.
    requestIdHeader: false,
    genReqId(req) {
      const header = req.headers['x-request-id']
      const value = Array.isArray(header) ? header[0] : header
      if (value && UUID_V4_RE.test(value)) return value
      return randomUUID()
    },
    disableRequestLogging: true,
    routerOptions: { ignoreTrailingSlash: true },
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY_HOPS : false,
  }) as unknown as FastifyApp

  fastify.setValidatorCompiler(validatorCompiler)
  fastify.setSerializerCompiler(serializerCompiler)

  fastify.setErrorHandler(
    (
      error: Error & { statusCode?: number },
      req: FastifyRequest,
      reply: { status: (code: number) => { send: (body: unknown) => unknown } }
    ) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          error: error.code.toLowerCase(), // e.g. 'unseal_failed' — match epics snake_case convention
          message: error.message,
        })
      }
      // Rate-limit 429 errors from @fastify/rate-limit — map to canonical API shape (AC-24)
      if (error.statusCode === 429) {
        // Route-scoped rate limiters (e.g. authRoutes) build their own { code, message } body
        // via errorResponseBuilder — pass it through as-is instead of the vault-unseal default.
        const { code } = error as unknown as { code?: string }
        if (code) {
          return reply.status(429).send({ code, message: error.message })
        }
        return reply.status(429).send({
          error: 'rate_limited',
          message: 'Too many unseal attempts',
          retryAfter: (error as unknown as { ttl?: number }).ttl
            ? Math.ceil((error as unknown as { ttl: number }).ttl / 1000)
            : undefined,
        })
      }
      // Body parsing happens before route handlers run, so the MFA verify-login route cannot
      // use its normal Zod parser for Fastify's 413/415 errors. Normalize both to the route's
      // documented validation contract without exposing parser internals.
      const parserErrorCode = (error as Error & { code?: string }).code
      if (shouldNormalizeMfaParserError(req.url, error.statusCode, parserErrorCode)) {
        return reply.status(422).send({
          code: 'validation_error',
          message: 'Request validation failed',
        })
      }
      // Preserve Fastify/Zod validation errors (statusCode already set)
      if (typeof error.statusCode === 'number') {
        return reply.status(error.statusCode).send({
          error: 'validation_error',
          message: error.message,
        })
      }
      req.log.error(
        { eventType: OperationalEvent.HTTP_REQUEST_FAILED, err: serializeLogError(error) },
        'Unhandled request error'
      )
      return reply
        .status(500)
        .send({ error: 'internal_error', message: 'An unexpected error occurred' })
    }
  )

  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Project Vault API',
        // Story 9.10 AC-1: sourced from getReleaseVersion() (RELEASE_VERSION), not a hardcoded
        // placeholder or package.json's permanent 0.0.1 — both the live GET /api/v1/openapi.json
        // route (D5) and the build-time generate-spec.ts script share this same createApp()
        // pipeline, so fixing the version source here fixes both with no duplicate logic.
        version: API_VERSION,
      },
    },
    transform: jsonSchemaTransform,
    // Without this, jsonSchemaTransform emits $ref pointers into components.schemas but
    // nothing ever populates that section, leaving every $ref dangling in the generated
    // document (see apps/api/src/scripts/generate-spec.ts, which serializes app.swagger()).
    transformObject: jsonSchemaTransformObject,
  })

  // D5/AC-6/AC-7: Swagger UI + the live spec route are only registered at all when docs are
  // enabled — conditionally skipping registration (rather than registering then 403-ing) so a
  // gated-off instance returns a plain 404 with no information leak, and route-audit.test.ts /
  // the OpenAPI spec itself never lists these routes when they don't exist. AC-16: both must
  // remain reachable while the vault is sealed — see plugins/vault-guard.ts's allowlist.
  if (docsEnabled({ enableApiDocs: env.ENABLE_API_DOCS, nodeEnv: env.NODE_ENV })) {
    await fastify.register(swaggerUi, { routePrefix: '/api/v1/docs' })
    await fastify.register(openapiRoutes, { prefix: '/api/v1' })
  }

  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })

  const allowedOrigins = new Set(env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()))

  await fastify.register(cors, {
    origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) {
        cb(null, true)
        return
      }
      cb(new Error('Not allowed by CORS'), false)
    },
    credentials: true,
  })

  await fastify.register(cookie)
  await fastify.register(await import('@fastify/multipart').then((m) => m.default), {
    limits: { fileSize: 1_048_576 },
  })
  await fastify.register(jwtPlugin)
  await fastify.register(machineJwtPlugin)
  await fastify.register(authenticatePlugin)
  await fastify.register(structuredLoggingPlugin)
  await fastify.register(httpMetricsPlugin)

  if (options.vaultGuardEnabled) {
    await fastify.register(vaultGuardPlugin)
  }

  await fastify.register(healthRoutes, { dbPool: options.dbPool })
  await fastify.register(statusRoutes, { dbPool: options.dbPool })
  await fastify.register(metricsRoutes, {
    metricsBindHost: options.metricsBindHost ?? env.METRICS_BIND_HOST,
  })
  // Registered always (regardless of guard) so vault endpoints appear in the OpenAPI spec.
  await fastify.register(vaultRoutes)
  await fastify.register(authRoutes, { prefix: '/api/v1/auth' })
  await fastify.register(machineTokenExchangeRoutes, { prefix: '/api/v1/auth' })
  // Story 14.3: start/callback are public (unauthenticated) SSO routes, mounted alongside local
  // auth at the same public prefix — see Dev Notes judgment call #6 on file/module placement.
  await fastify.register(ssoRoutes, { prefix: '/api/v1/auth/sso' })
  // Story 14.4: domain-lookup is also public/pre-auth (the caller has no session yet) — mounted
  // at the same prefix as start/callback, in its own module (Dev Notes Project Structure Notes).
  await fastify.register(domainLookupRoutes, { prefix: '/api/v1/auth/sso' })
  /* eslint-disable sonarjs/no-duplicate-string -- route-audit.test.ts statically parses these
     literal prefix strings; a shared constant would make them invisible to that parser. */
  await fastify.register(orgRoutes, { prefix: '/api/v1/org' })
  // Story 14.6: authenticated, org-scoped SSO-domain admin CRUD — a separate, stricter-validation
  // sibling to the pre-auth domainLookupRoutes above (see Dev Notes scope boundaries).
  await fastify.register(orgSsoDomainsRoutes, { prefix: '/api/v1/org' })
  await fastify.register(auditRoutes, { prefix: '/api/v1/org' })
  await fastify.register(erasureRoutes, { prefix: '/api/v1/org' })
  await fastify.register(projectRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(projectInvitationRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(invitationTokenRoutes, { prefix: '/api/v1/invitations' })
  await fastify.register(credentialRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(rotationRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(credentialSharesRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(credentialShareAccessRoutes, { prefix: '/api/v1/shares' })
  await fastify.register(externalCredentialShareAccessRoutes, {
    prefix: '/api/v1/external-shares',
  })
  await fastify.register(monitoringRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(statusPageRoutes, { prefix: '/api/v1/projects' })
  /* eslint-enable sonarjs/no-duplicate-string */
  await fastify.register(dashboardRoutes, { prefix: '/api/v1/dashboard' })
  await fastify.register(healthDashboardRoutes, { prefix: '/api/v1/health-dashboard' })
  await fastify.register(publicStatusPageRoutes, { prefix: '/api/v1/status-pages' })
  await fastify.register(onboardingRoutes, { prefix: '/api/v1/users' })
  await fastify.register(usersRoutes, { prefix: '/api/v1/users' })
  await fastify.register(searchRoutes, { prefix: '/api/v1' })
  // '/api/v1/admin' hosts two distinct route families sharing one URL prefix (Story 9.2 D2):
  // adminRoutes/backupRoutes are pre-existing; settingsRoutes/orgsRoutes/resourceUsageRoutes are
  // this story's new platform-operator-scoped (instance-wide) routes — deliberately three
  // separate files/registrations (not one modules/platform-admin/routes.ts) so
  // route-audit.test.ts's generic AST scan (which resolves each registrar to the exact file
  // app.ts imports it from) sees each file's secureRoute() calls directly, same as every other
  // module here.
  const ADMIN_PREFIX = '/api/v1/admin'
  await fastify.register(adminRoutes, { prefix: ADMIN_PREFIX })
  await fastify.register(backupRoutes, { prefix: ADMIN_PREFIX })
  await fastify.register(settingsRoutes, { prefix: ADMIN_PREFIX })
  await fastify.register(orgsRoutes, { prefix: ADMIN_PREFIX })
  await fastify.register(resourceUsageRoutes, { prefix: ADMIN_PREFIX })
  // Story 1.19 AC-5/AC-6: platform-operator+MFA-gated CRUD for the GET /status bearer token,
  // same route-audit.test.ts rationale as the sibling registrations above (own file, own
  // secureRoute() calls directly visible to the AST scan).
  await fastify.register(statusTokenRoutes, { prefix: ADMIN_PREFIX, dbPool: options.dbPool })
  // Story 14.2: functionally an admin-status read, so mounted at ADMIN_PREFIX alongside the
  // routes above even though the implementation file lives under extensions/ (conceptually part
  // of the extension subsystem, not modules/admin/'s "system config only" scope) — see Dev Notes.
  await fastify.register(extensionStatusRoutes, { prefix: ADMIN_PREFIX })
  // Story 14.3 Task 7: OrgAdmin-initiated external-identity linking endpoint.
  await fastify.register(externalIdentityRoutes, { prefix: ADMIN_PREFIX })
  // Story 16.1: flat module (not nested under modules/admin/), matching the existing
  // backup/admin sibling convention — see architecture.md's file-structure tree.
  await fastify.register(themingRoutes, { prefix: ADMIN_PREFIX })
  // Story 9.4 AC-10: a distinct sibling module to platform-admin (audit-log read/verify vs.
  // instance administration) under its own '/api/v1/platform' prefix, not nested under
  // ADMIN_PREFIX.
  await fastify.register(platformAuditRoutes, { prefix: '/api/v1/platform' })
  await fastify.register(notificationRoutes, { prefix: '/api/v1' })
  await fastify.register(machineUserRoutes, { prefix: '/api/v1' })
  await fastify.register(machineCredentialRoutes, { prefix: '/api/v1/machine' })
  await fastify.register(cacheActivatedRoutes, { prefix: '/api/v1/machine' })
  await fastify.register(securityAlertActionsRoutes, { prefix: '/api/v1/security-alerts' })
  await fastify.register(organizationSettingsRoutes, { prefix: '/api/v1/organizations' })
  // Story 16.2: personal, per-user theme selection — deliberately mounted at plain '/api/v1'
  // (not ADMIN_PREFIX like 16.1's reload endpoint above), since any authenticated org member may
  // call these, not just OrgAdmins. Kept in its own file (selection-routes.ts) rather than
  // themingRoutes above so route-audit.test.ts's per-file prefix resolution stays correct for
  // both route families.
  await fastify.register(themeSelectionRoutes, { prefix: '/api/v1' })

  // Story 14.2 Task 7: after every core route is registered, so the local-first invariant is
  // trivially satisfied even though this story doesn't yet wire registerAuthStrategy() (that's
  // Story 14.3). Called here (not from main.ts) so createApp() stays a complete, testable unit.
  // loadExtension() is designed to never throw/reject — a bug in this story's own code cannot
  // regress AC-3's "still starts" guarantee — but `await` (not fire-and-forget) so state is
  // fully resolved before createApp() returns to any caller (e.g. /health's first response).
  await loadExtension(env.VAULT_EXTENSIONS_PACKAGE, {
    logger: fastify.log,
    allowApiVersionAboveHost: env.VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST,
  })

  // Story 16.1 AC-1/Task 5: startup automatic reload pass for VAULT_THEMES_DIR — identical code
  // path to the manual POST /admin/themes/reload endpoint, just invoked here so a fresh
  // container picks up already-mounted themes without requiring a manual trigger. `await`, not
  // fire-and-forget, matching loadExtension()'s own convention immediately above; never throws.
  await reloadThemesWithFanout(env.VAULT_THEMES_DIR, { logger: fastify.log })

  // Story 14.3 Task 3: after loadExtension() resolves, append a registered authStrategy hook
  // (if any) to authStrategies — local-first invariant is preserved unconditionally either way.
  wireExtensionAuthStrategy(getExtensionStatus())

  return fastify
}
