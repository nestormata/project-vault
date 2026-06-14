import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import { healthRoutes } from './routes/health.js'
import { metricsRoutes } from './routes/metrics.js'
import { env } from './config/env.js'

type DbPool = {
  query: (sql: string) => Promise<unknown>
}

export type AppOptions = {
  dbPool?: DbPool
  logger?: boolean | object
  metricsBindHost?: string
}

export type FastifyApp = ReturnType<typeof Fastify>

export async function createApp(options: AppOptions = {}): Promise<FastifyApp> {
  const logger =
    options.logger === false
      ? false
      : options.logger !== undefined
        ? options.logger
        : {
            level: env.LOG_LEVEL,
          }

  const fastify = Fastify({ logger })

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
