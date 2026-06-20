import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod'
import { healthRoutes } from './routes/health.js'
import { metricsRoutes } from './routes/metrics.js'
import { env } from './config/env.js'
import type { FastifyApp } from './lib/fastify-app.js'

type DbPool = {
  query: (sql: string) => Promise<unknown>
}

export type AppOptions = {
  dbPool?: DbPool
  logger?: boolean | object
  metricsBindHost?: string
}

export async function createApp(options: AppOptions = {}): Promise<FastifyApp> {
  const logger =
    options.logger === false
      ? false
      : options.logger !== undefined
        ? options.logger
        : {
            level: env.LOG_LEVEL,
          }

  const fastify: FastifyApp = Fastify({ logger }) as unknown as FastifyApp

  fastify.setValidatorCompiler(validatorCompiler)
  fastify.setSerializerCompiler(serializerCompiler)

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
  })

  await fastify.register(healthRoutes, { dbPool: options.dbPool })
  await fastify.register(metricsRoutes, {
    metricsBindHost: options.metricsBindHost ?? env.METRICS_BIND_HOST,
  })

  return fastify
}
