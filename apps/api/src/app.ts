import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { platformAuditRoutes } from './modules/platform-audit/routes.js'
import { notificationRoutes } from './modules/notifications/routes.js'
import { machineUserRoutes } from './modules/machine-users/routes.js'
import { machineTokenExchangeRoutes } from './modules/machine-users/token-exchange-routes.js'
import { machineCredentialRoutes } from './modules/machine-users/machine-credential-routes.js'
import { cacheActivatedRoutes } from './modules/machine-users/cache-activated-routes.js'
import { securityAlertActionsRoutes } from './modules/org/security-alert-actions-routes.js'
import { organizationSettingsRoutes } from './modules/org/organization-settings-routes.js'
import { erasureRoutes } from './modules/compliance/erasure-routes.js'
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
import { readPackageVersion } from './lib/package-version.js'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyRequest } from 'fastify'

// RFC 4122 UUID v4: version nibble = 4, variant nibble ∈ {8,9,a,b}. Do NOT loosen
// this regex — nil UUID and non-v4 formats are intentionally rejected so a caller
// cannot inject arbitrary trace-correlation strings via X-Request-ID.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// AC-19: read once at module load — same convention as routes/health.ts's existing pkg.version
// read — rather than on every request or every createApp() call.
const __dirname = dirname(fileURLToPath(import.meta.url))
const API_VERSION = readPackageVersion(resolve(__dirname, '../package.json'))

type DbPool = {
  query: (sql: string) => Promise<unknown>
}

export type AppOptions = {
  dbPool?: DbPool
  logger?: boolean | object
  metricsBindHost?: string
  vaultGuardEnabled?: boolean
}

export async function createApp(options: AppOptions = {}): Promise<FastifyApp> {
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
        // AC-19: sourced from apps/api/package.json at generation time, not a hardcoded
        // placeholder — both the live GET /api/v1/openapi.json route (D5) and the build-time
        // generate-spec.ts script share this same createApp() pipeline, so fixing the version
        // source here fixes both with no duplicate version-reading logic.
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
  await fastify.register(metricsRoutes, {
    metricsBindHost: options.metricsBindHost ?? env.METRICS_BIND_HOST,
  })
  // Registered always (regardless of guard) so vault endpoints appear in the OpenAPI spec.
  await fastify.register(vaultRoutes)
  await fastify.register(authRoutes, { prefix: '/api/v1/auth' })
  await fastify.register(machineTokenExchangeRoutes, { prefix: '/api/v1/auth' })
  /* eslint-disable sonarjs/no-duplicate-string -- route-audit.test.ts statically parses these
     literal prefix strings; a shared constant would make them invisible to that parser. */
  await fastify.register(orgRoutes, { prefix: '/api/v1/org' })
  await fastify.register(auditRoutes, { prefix: '/api/v1/org' })
  await fastify.register(erasureRoutes, { prefix: '/api/v1/org' })
  await fastify.register(projectRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(projectInvitationRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(invitationTokenRoutes, { prefix: '/api/v1/invitations' })
  await fastify.register(credentialRoutes, { prefix: '/api/v1/projects' })
  await fastify.register(rotationRoutes, { prefix: '/api/v1/projects' })
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

  return fastify
}
