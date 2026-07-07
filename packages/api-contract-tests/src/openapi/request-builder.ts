import { randomUUID } from 'node:crypto'
import type { OpenApiOperation, OpenApiParameter } from './load-spec.js'

/**
 * Real fixture IDs bootstrapped once per test run (see ../fixtures/resources.ts) — used to fill
 * path params whose name matches a resource this suite actually created, so GET-by-ID operations
 * have a real chance at a 2xx happy path instead of always landing on 404.
 */
export type FixtureIds = Partial<
  Record<
    | 'projectId'
    | 'credentialId'
    | 'machineUserId'
    | 'keyId'
    | 'dependencyId'
    | 'userId'
    | 'rotationId'
    | 'securityAlertId'
    | 'invitationId',
    string
  >
>

// Path params whose values are not UUIDs in this codebase's routing — falling back to a random
// UUID for these would be a syntactically nonsensical fixture (e.g. a lookup-by-name route would
// never plausibly match a UUID-shaped name). A fixed opaque string is more honest: it still
// exercises the "resource not found" path these routes document, without pretending to be a
// realistic value.
const NON_UUID_PATH_PARAMS = new Set(['token', 'filename', 'name'])
const NON_UUID_FALLBACK = 'contract-test-nonexistent-value'

function fillPathParam(name: string, fixtures: FixtureIds): string {
  // eslint-disable-next-line security/detect-object-injection -- name is a path-param name parsed from this repo's own generated OpenAPI spec, not external/user input.
  const known = (fixtures as Record<string, string | undefined>)[name]
  if (known) return known
  if (NON_UUID_PATH_PARAMS.has(name)) return NON_UUID_FALLBACK
  // Every other path param in this API is a UUID primary key — a syntactically valid but
  // non-existent UUID exercises exactly the "resource not found" path these routes document.
  return randomUUID()
}

export function buildPath(pathTemplate: string, fixtures: FixtureIds): string {
  return pathTemplate.replace(/\{(\w+)\}/g, (_match, name: string) =>
    encodeURIComponent(fillPathParam(name, fixtures))
  )
}

function minimalQueryValue(schema: Record<string, unknown> | undefined): string | undefined {
  const type = schema?.['type']
  if (type === 'integer' || type === 'number') return '1'
  if (type === 'boolean') return 'true'
  if (type === 'string') {
    const enumValues = schema?.['enum']
    if (Array.isArray(enumValues) && enumValues.length > 0) return String(enumValues[0])
    return 'test'
  }
  return undefined
}

/**
 * Builds a query string covering every *required* query parameter with a schema-type-appropriate
 * minimal value (optional params are deliberately left unset, so the suite also exercises each
 * operation's real defaults — e.g. PageLimitQueryShape's page=1/limit=20).
 */
export function buildQueryString(parameters: OpenApiParameter[] | undefined): string {
  if (!parameters) return ''
  const params = new URLSearchParams()
  for (const param of parameters) {
    if (param.in !== 'query' || !param.required) continue
    const value = minimalQueryValue(param.schema)
    if (value !== undefined) params.set(param.name, value)
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Mutation bodies are deliberately minimal (`{}`), not schema-synthesized: most POST/PUT/PATCH
 * routes in this codebase validate their body manually inside the handler (via parseBody()) and
 * so are not even documented as having a requestBody in the generated spec (@fastify/swagger only
 * documents a requestBody when it's wired through Fastify's own schema.body option). An empty
 * body against a route requiring fields is expected to land on a documented 422
 * (ApiErrorSchema) — itself a valid, schema-conformant, documented-status outcome per AC-9's
 * literal definition ("the actual response status code is one the spec documents"), not a
 * fixture-generation failure. This keeps the suite honest and simple rather than half-heartedly
 * synthesizing bodies that would still usually fail validation on some other field anyway.
 */
export function buildRequestBody(operation: OpenApiOperation): unknown {
  return operation.requestBody ? {} : undefined
}
