import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { z } from 'zod/v4'
import { ApiErrorSchema } from '@project-vault/shared'
import type { FastifyApp } from './fastify-app.js'

export { ApiErrorSchema }
export { ApiResponseSchema } from '@project-vault/shared'

export const defaultErrorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  429: ApiErrorSchema,
  500: ApiErrorSchema,
} as const

/**
 * Shared page-based pagination response metadata fields (`total`/`page`/`limit`/`hasNext`) — used
 * by every page-based list endpoint (org security-alerts, monitoring health-history/alerts).
 * Centralized so structurally-identical response schemas across modules don't trip the repo's
 * zero-duplication jscpd gate.
 */
export const paginatedListMetaFields = {
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  hasNext: z.boolean(),
} as const

export function withRouteTypeProvider(app: FastifyApp) {
  return app.withTypeProvider<ZodTypeProvider>()
}

export { withOrg as withOrgScope } from '@project-vault/db'
