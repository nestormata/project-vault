import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod'
import { healthRoutes } from './routes/health.js'
import { metricsRoutes } from './routes/metrics.js'
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
import { notificationRoutes } from './modules/notifications/routes.js'
import { machineUserRoutes } from './modules/machine-users/routes.js'
import { machineTokenExchangeRoutes } from './modules/machine-users/token-exchange-routes.js'
import { machineCredentialRoutes } from './modules/machine-users/machine-credential-routes.js'
import { cacheActivatedRoutes } from './modules/machine-users/cache-activated-routes.js'
import { securityAlertActionsRoutes } from './modules/org/security-alert-actions-routes.js'
import { organizationSettingsRoutes } from './modules/org/organization-settings-routes.js'
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

export async function createApp(options: AppOptions = {}): Promise<FastifyApp> {
  const logger =
    options.logger === false
      ? false
      : options.logger !== undefined
        ? options.logger
        : createLoggerConfig(env)

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
        version: '0.0.1',
      },
    },
    transform: jsonSchemaTransform,
  })

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

  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim())

  await fastify.register(cors, {
    origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) {
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
  await fastify.register(orgRoutes, { prefix: '/api/v1/org' })
  await fastify.register(auditRoutes, { prefix: '/api/v1/org' })
  /* eslint-disable sonarjs/no-duplicate-string -- route-audit.test.ts statically parses these
     literal prefix strings; a shared constant would make them invisible to that parser. */
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
  await fastify.register(adminRoutes, { prefix: '/api/v1/admin' })
  await fastify.register(notificationRoutes, { prefix: '/api/v1' })
  await fastify.register(machineUserRoutes, { prefix: '/api/v1' })
  await fastify.register(machineCredentialRoutes, { prefix: '/api/v1/machine' })
  await fastify.register(cacheActivatedRoutes, { prefix: '/api/v1/machine' })
  await fastify.register(securityAlertActionsRoutes, { prefix: '/api/v1/security-alerts' })
  await fastify.register(organizationSettingsRoutes, { prefix: '/api/v1/organizations' })

  return fastify
}
