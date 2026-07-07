import { z } from 'zod/v4'
import { paginatedListMetaFields } from '../../lib/api-contracts.js'

const SEARCH_TYPES = ['credentials', 'projects'] as const
export type SearchType = (typeof SEARCH_TYPES)[number]

function parseSearchTypes(
  typesRaw: string | undefined,
  ctx: z.RefinementCtx
): SearchType[] | typeof z.NEVER {
  const trimmed = typesRaw?.trim()
  if (!trimmed) {
    return ['credentials', 'projects']
  }
  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const invalid = parts.filter((part) => !SEARCH_TYPES.includes(part as SearchType))
  if (invalid.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'invalid_search_type', path: ['types'] })
    return z.NEVER
  }
  return parts as SearchType[]
}

// Story 9.3 D8.3/AC-11: `limit` deliberately keeps its existing, already-tested 1-50 bound
// (distinct from PageLimitQueryShape's 1-100) rather than being migrated onto the shared shape:
// this endpoint already accepted `limit` server-side with its own convention, so D8.3's "if not
// already accepted server-side" condition does not apply here.
function parseSearchLimit(
  limitRaw: string | undefined,
  ctx: z.RefinementCtx
): number | typeof z.NEVER {
  const trimmed = limitRaw?.trim()
  if (trimmed === undefined || trimmed.length === 0) {
    return 20
  }
  if (!/^\d+$/.test(trimmed)) {
    ctx.addIssue({ code: 'custom', message: 'limit must be an integer', path: ['limit'] })
    return z.NEVER
  }
  const limit = Number.parseInt(trimmed, 10)
  if (limit < 1 || limit > 50) {
    ctx.addIssue({ code: 'custom', message: 'limit must be between 1 and 50', path: ['limit'] })
    return z.NEVER
  }
  return limit
}

// Story 9.3 D8.3/AC-11: new — search previously accepted no page param at all.
function parseSearchPage(
  pageRaw: string | undefined,
  ctx: z.RefinementCtx
): number | typeof z.NEVER {
  const trimmed = pageRaw?.trim()
  if (trimmed === undefined || trimmed.length === 0) {
    return 1
  }
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) < 1) {
    ctx.addIssue({ code: 'custom', message: 'page must be a positive integer', path: ['page'] })
    return z.NEVER
  }
  return Number.parseInt(trimmed, 10)
}

export const SearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    types: z.string().optional(),
    limit: z.string().optional(),
    page: z.string().optional(),
  })
  .strict()
  .transform((input, ctx) => {
    const types = parseSearchTypes(input.types, ctx)
    if (types === z.NEVER) return z.NEVER
    const limit = parseSearchLimit(input.limit, ctx)
    if (limit === z.NEVER) return z.NEVER
    const page = parseSearchPage(input.page, ctx)
    if (page === z.NEVER) return z.NEVER

    return { q: input.q, types, limit, page }
  })
  .meta({ id: 'SearchQuery' })

export const SearchResultItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('credential'),
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    projectId: z.uuid(),
    projectName: z.string(),
    matchedField: z.enum(['name', 'description', 'tags']),
    snippet: z.string().nullable(),
    expiresAt: z.iso.datetime().nullable(),
  }),
  z.object({
    type: z.literal('project'),
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    slug: z.string(),
    matchedField: z.enum(['name', 'tags']),
    snippet: z.string().nullable(),
    credentialCount: z.number().int().nonnegative(),
  }),
])

export const SearchResponseSchema = z
  .object({
    data: z.object({
      results: z.array(SearchResultItemSchema),
      query: z.string(),
      types: z.array(z.enum(['credentials', 'projects'])),
      // Story 9.3 D8.3/AC-11: previously entirely absent — `results` keeps its existing,
      // more semantically-correct field name (D7's rule is field-name-agnostic).
      ...paginatedListMetaFields,
    }),
  })
  .meta({ id: 'SearchResponse' })

export type SearchQuery = z.infer<typeof SearchQuerySchema>
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>
