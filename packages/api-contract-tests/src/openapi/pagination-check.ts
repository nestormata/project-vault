/**
 * Story 9.3 D7 — an independent, schema-agnostic check: for every 2xx JSON response whose parsed
 * `data` is an object containing at least one array-typed field, the actual parsed body must also
 * contain `total`/`page`/`limit`/`hasNext` as siblings of that array field. This is checked
 * against the real HTTP response bytes, not the route's own OpenAPI-declared response schema —
 * `@fastify/type-provider-zod`'s serializer silently strips any key a route's Zod response schema
 * doesn't declare, so "the response matches its own schema" can be trivially true even when a
 * required field is missing from the wire response entirely (the exact class of bug this rule
 * exists to catch — see the pre-fix machine-users example in the story's D7/D8 notes).
 */

/**
 * Exemption allowlist for genuinely different pagination styles. Empty as of this story — Story
 * 8.2's cursor-paginated audit search (`{ items, nextCursor, hasMore }` or similar) is the one
 * anticipated future entry; add it here (by `METHOD /path` key) when that story ships, per the
 * story's own Open Questions. `GET /api/v1/auth/sessions` does not need an entry: it returns a
 * bare top-level array (`{ data: [...] }`), not an array nested inside a `data` object, so D7's
 * heuristic ("an array-typed *property* of the `data` object") does not structurally match it at
 * all — confirmed by inspecting its generated response schema at implementation time.
 */
export const PAGINATION_EXEMPT_OPERATIONS = new Set<string>([])

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns the missing pagination field names (empty array = compliant) if `body.data` is an
 * object with at least one array-typed field; returns `null` when the array-in-object heuristic
 * doesn't apply at all (e.g. `data` is itself an array, or a single non-collection resource) —
 * `null` is not a failure, it means this check has nothing to say about this response.
 */
export function checkPaginationFields(body: unknown): string[] | null {
  if (!isPlainObject(body) || !('data' in body)) return null
  const data = body['data']
  if (!isPlainObject(data)) return null

  const hasArrayField = Object.values(data).some((value) => isArray(value))
  if (!hasArrayField) return null

  const REQUIRED_FIELDS = ['total', 'page', 'limit', 'hasNext'] as const
  const missing = REQUIRED_FIELDS.filter((field) => !(field in data))
  return missing
}
