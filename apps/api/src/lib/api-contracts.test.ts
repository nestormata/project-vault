import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { createApp } from '../app.js'
import {
  ApiResponseSchema,
  defaultErrorResponses,
  withOrgScope,
  withRouteTypeProvider,
} from './api-contracts.js'

type OpenApiDocument = {
  paths?: Record<string, unknown>
  components?: {
    schemas?: Record<string, unknown>
  }
}

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
  },
}))

describe('API workspace contracts', () => {
  it('keeps the shared ApiError schema available for default error responses', () => {
    const result = defaultErrorResponses[400].safeParse({
      code: 'validation_error',
      message: 'Validation failed',
    })

    expect(result.success).toBe(true)
  })

  it('exposes the db org-scope helper through the api boundary', () => {
    expect(typeof withOrgScope).toBe('function')
  })

  it('registers Zod-backed schemas with Fastify swagger output', async () => {
    const app = await createApp({ logger: false })

    withRouteTypeProvider(app).route({
      method: 'GET',
      url: '/contract-check',
      schema: {
        response: {
          200: ApiResponseSchema(z.object({ ok: z.literal(true) })),
          400: defaultErrorResponses[400],
        },
      },
      handler: async () => ({
        data: {
          ok: true,
        },
      }),
    })

    await app.ready()

    const document = app.swagger() as OpenApiDocument
    const contractPath = document.paths?.['/contract-check']
    expect(contractPath).toBeDefined()
    expect(JSON.stringify(contractPath)).toContain('#/components/schemas/ApiError')

    await app.close()
  })
})
