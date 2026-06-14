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

export function parsePagination(
  rawPage: unknown,
  rawLimit: unknown,
  defaults: { page: number; limit: number; maxLimit: number } = {
    page: 1,
    limit: 20,
    maxLimit: 100,
  }
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
