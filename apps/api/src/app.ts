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
import { vaultGuardPlugin } from './plugins/vault-guard.js'
import { jwtPlugin } from './plugins/jwt.js'
import { env } from './config/env.js'
import { AppError } from './lib/errors.js'
import type { FastifyApp } from './lib/fastify-app.js'

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
        : {
            level: env.LOG_LEVEL,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.passphrase',
              ],
              censor: '[REDACTED]',
            },
          }

  // ignoreTrailingSlash: Fastify's router treats "/health" and "/health/" as distinct
  // routes by default, which would 404 before the vault guard's own normalizePath() ever
  // runs (AC-5 requires /health/ to behave identically to /health while sealed).
  const fastify: FastifyApp = Fastify({
    logger,
    routerOptions: { ignoreTrailingSlash: true },
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY_HOPS : false,
  }) as unknown as FastifyApp

  fastify.setValidatorCompiler(validatorCompiler)
  fastify.setSerializerCompiler(serializerCompiler)

  fastify.setErrorHandler(
    (
      error: Error & { statusCode?: number },
      _req: unknown,
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
      fastify.log.error(error)
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
  await fastify.register(jwtPlugin)

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

  return fastify
}
