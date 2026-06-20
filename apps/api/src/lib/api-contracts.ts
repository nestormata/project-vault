import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { withOrg } from '@project-vault/db'
import { ApiErrorSchema, ApiResponseSchema } from '@project-vault/shared'
import type { FastifyApp } from './fastify-app.js'

export { ApiErrorSchema, ApiResponseSchema }

export const defaultErrorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  429: ApiErrorSchema,
  500: ApiErrorSchema,
} as const

export function withRouteTypeProvider(app: FastifyApp) {
  return app.withTypeProvider<ZodTypeProvider>()
}

export const withOrgScope = withOrg
