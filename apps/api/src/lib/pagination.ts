import { z } from 'zod/v4'

/** Shared page/limit query field shape — spread into a module's own Zod object so each list
 * endpoint's query schema keeps its own `.meta({ id })`, without repeating these two field
 * definitions verbatim at every call site (rotation, machine-users, ...). */
export const PageLimitQueryShape = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}

export type PaginationParams = {
  page: number
  limit: number
}

export type PaginationMeta = {
  page: number
  limit: number
  total: number
  hasNext: boolean
}

const DEFAULT_PAGINATION_LIMITS = { page: 1, limit: 20, maxLimit: 100 }

export function parsePagination(
  rawPage: unknown,
  rawLimit: unknown,
  defaults: { page: number; limit: number; maxLimit: number } = DEFAULT_PAGINATION_LIMITS
): PaginationParams {
  const page = Number(rawPage) >= 1 ? Math.floor(Number(rawPage)) : defaults.page
  const limit =
    Number(rawLimit) >= 1
      ? Math.min(Math.floor(Number(rawLimit)), defaults.maxLimit)
      : defaults.limit
  return { page, limit }
}

export function buildPaginationMeta(params: PaginationParams, total: number): PaginationMeta {
  return {
    page: params.page,
    limit: params.limit,
    total,
    hasNext: params.page * params.limit < total,
  }
}

export function paginationOffset(params: PaginationParams): number {
  return (params.page - 1) * params.limit
}

export const PAGE_OUT_OF_RANGE_ERROR = {
  code: 'page_out_of_range',
  message: 'Page is too deep; narrow your filters',
} as const

/**
 * Resolves page/limit query values into a bounded offset, or `null` once the requested offset
 * exceeds `maxOffset` (caller sends `PAGE_OUT_OF_RANGE_ERROR` as a 422 in that case). Shared by
 * every list endpoint that caps its offset (credentials, machine-users, api-keys) so the
 * cap-check itself isn't duplicated per call site.
 */
export function resolvePaginationOffset(
  rawPage: unknown,
  rawLimit: unknown,
  maxOffset: number
): { pagination: PaginationParams; offset: number } | null {
  const pagination = parsePagination(rawPage, rawLimit)
  const offset = paginationOffset(pagination)
  if (offset > maxOffset) return null
  return { pagination, offset }
}
