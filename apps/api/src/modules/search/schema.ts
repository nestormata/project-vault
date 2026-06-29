import { z } from 'zod/v4'

const SEARCH_TYPES = ['credentials', 'projects'] as const
export type SearchType = (typeof SEARCH_TYPES)[number]

export const SearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    types: z.string().optional(),
    limit: z.string().optional(),
  })
  .strict()
  .transform((input, ctx) => {
    const typesRaw = input.types?.trim()
    let types: SearchType[]
    if (!typesRaw) {
      types = ['credentials', 'projects']
    } else {
      const parts = typesRaw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      const invalid = parts.filter((part) => !SEARCH_TYPES.includes(part as SearchType))
      if (invalid.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'invalid_search_type',
          path: ['types'],
        })
        return z.NEVER
      }
      types = parts as SearchType[]
    }

    const limitRaw = input.limit?.trim()
    let limit = 20
    if (limitRaw !== undefined && limitRaw.length > 0) {
      if (!/^\d+$/.test(limitRaw)) {
        ctx.addIssue({
          code: 'custom',
          message: 'limit must be an integer',
          path: ['limit'],
        })
        return z.NEVER
      }
      limit = Number.parseInt(limitRaw, 10)
      if (limit < 1 || limit > 50) {
        ctx.addIssue({
          code: 'custom',
          message: 'limit must be between 1 and 50',
          path: ['limit'],
        })
        return z.NEVER
      }
    }

    return { q: input.q, types, limit }
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
      total: z.number().int().nonnegative(),
      query: z.string(),
      types: z.array(z.enum(['credentials', 'projects'])),
    }),
  })
  .meta({ id: 'SearchResponse' })

export type SearchQuery = z.infer<typeof SearchQuerySchema>
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>
