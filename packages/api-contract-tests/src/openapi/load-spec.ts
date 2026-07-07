import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// D6 point 3(e): the freshly-generated packages/shared/openapi.json (D4) — CI runs this suite
// after `pnpm generate-spec`, so this is always the current tree's real spec, not a stale one.
const OPENAPI_JSON_PATH = resolve(__dirname, '../../../shared/openapi.json')

export type JsonSchema = Record<string, unknown>

export type OpenApiParameter = {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  schema?: JsonSchema
}

export type OpenApiResponse = {
  content?: { 'application/json'?: { schema?: JsonSchema } }
}

export type OpenApiOperation = {
  parameters?: OpenApiParameter[]
  requestBody?: { content?: { 'application/json'?: { schema?: JsonSchema } } }
  responses: Record<string, OpenApiResponse>
}

export type OpenApiDocument = {
  openapi: string
  info: { title: string; version: string }
  components?: { schemas?: Record<string, JsonSchema> }
  paths: Record<string, Record<string, OpenApiOperation>>
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export type Operation = {
  method: HttpMethod
  path: string
  operation: OpenApiOperation
}

export function loadOpenApiSpec(path: string = OPENAPI_JSON_PATH): OpenApiDocument {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path defaults to this repo's own generated spec file; only ever overridden by test fixtures.
  return JSON.parse(readFileSync(path, 'utf-8')) as OpenApiDocument
}

/**
 * AC-8: programmatically enumerates every `path`+`method` combination from the spec's `paths`
 * object — one operation per combination, with no route hardcoded into a fixed list that could
 * silently go stale as new routes are added.
 */
export function enumerateOperations(spec: OpenApiDocument): Operation[] {
  const operations: Operation[] = []
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      // eslint-disable-next-line security/detect-object-injection -- method is drawn from the fixed HTTP_METHODS tuple, not external input.
      const operation = methods[method]
      if (operation) operations.push({ method, path, operation })
    }
  }
  return operations
}

export function operationKey(op: Operation): string {
  return `${op.method.toUpperCase()} ${op.path}`
}
