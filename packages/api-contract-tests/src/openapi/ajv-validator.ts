// Named import (not `import Ajv from 'ajv'`) — ajv 8.x's CJS/ESM dual-typed package confuses
// TS's NodeNext default-import interop without esModuleInterop; the named `Ajv` class export
// avoids that entirely.
import { Ajv } from 'ajv'
import type { ErrorObject, ValidateFunction } from 'ajv'
import type { JsonSchema, OpenApiDocument } from './load-spec.js'

// strict:false — OpenAPI's JSON-schema dialect includes vendor keywords (nullable, example, ...)
// ajv's strict mode would otherwise reject; `format` keywords are intentionally left
// unvalidated (no ajv-formats) — this suite checks structural shape/status conformance (AC-9),
// not deep string-format correctness, which is already covered by each route's own Zod
// validation on the way out.
const ajv = new Ajv({ strict: false, allErrors: true })
const validatorCache = new Map<string, ValidateFunction>()

type BoundsCarrier = {
  minimum?: unknown
  maximum?: unknown
  exclusiveMinimum?: unknown
  exclusiveMaximum?: unknown
  [key: string]: unknown
}

/** True only for the exact shape this suite's schemas ever produce: a boolean-form exclusive
 * bound paired with a numeric bound (`{ minimum: 0, exclusiveMinimum: true }`). */
function isBooleanFormExclusiveBound(exclusiveFlag: unknown, bound: unknown): boolean {
  return exclusiveFlag === true && typeof bound === 'number'
}

/** Rewrites one bound pair (e.g. `minimum`/`exclusiveMinimum`) into ajv 8's numeric-exclusive-
 * bound form, returning only the field(s) that should be present — spread this into the result
 * object so an omitted bound never appears as an explicit `undefined` key. */
function normalizedBoundFields(
  boundKey: 'minimum' | 'maximum',
  exclusiveKey: 'exclusiveMinimum' | 'exclusiveMaximum',
  bound: unknown,
  exclusiveFlag: unknown
): BoundsCarrier {
  if (isBooleanFormExclusiveBound(exclusiveFlag, bound)) return { [exclusiveKey]: bound }
  return {
    ...(bound !== undefined ? { [boundKey]: bound } : {}),
    ...(exclusiveFlag !== undefined && exclusiveFlag !== false
      ? { [exclusiveKey]: exclusiveFlag }
      : {}),
  }
}

/** Rewrites the boolean-form exclusive-bound pairs (e.g. `minimum`/`exclusiveMinimum: true`) on
 * `obj` into the numeric form ajv 8 expects. Named keys only (no dynamic property access, no
 * `delete`) — OpenAPI/JSON-Schema only ever uses these four fixed keyword names for numeric
 * bounds. */
function rewriteExclusiveBounds(obj: BoundsCarrier): BoundsCarrier {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, ...rest } = obj
  return {
    ...rest,
    ...normalizedBoundFields('minimum', 'exclusiveMinimum', minimum, exclusiveMinimum),
    ...normalizedBoundFields('maximum', 'exclusiveMaximum', maximum, exclusiveMaximum),
  }
}

/**
 * Zod's OpenAPI-3.0-targeting JSON-schema output (via `@fastify/type-provider-zod`) emits the
 * legacy/OpenAPI-3.0 boolean form of exclusive bounds (`{ minimum: 0, exclusiveMinimum: true }`)
 * rather than the JSON-Schema-draft-2019+ numeric form ajv 8 expects (`{ exclusiveMinimum: 0 }`)
 * — every `.positive()`/`.int().positive()` Zod field (page, limit, version numbers, ...)
 * produces this shape. Recursively rewrites both `exclusiveMinimum`/`exclusiveMaximum` into the
 * numeric form ajv understands, leaving everything else (including `$ref`s) untouched.
 */
function normalizeExclusiveBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeExclusiveBounds)
  if (typeof node !== 'object' || node === null) return node

  const rewritten = rewriteExclusiveBounds(node as BoundsCarrier)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rewritten)) {
    // eslint-disable-next-line security/detect-object-injection -- key comes from Object.entries() of our own already-copied object, not external input.
    result[key] = normalizeExclusiveBounds(value)
  }
  return result
}

/**
 * Compiles (and caches) an ajv validator for a single response schema, resolving any
 * `$ref: '#/components/schemas/...'` against the full spec document's `components.schemas` — the
 * `$ref` is a JSON Pointer relative to whatever document ajv is compiling, so embedding
 * `components` as a sibling of the response schema inside the same object makes the pointer
 * resolve correctly without needing a second `addSchema()` call per operation.
 */
export function compileResponseValidator(
  spec: OpenApiDocument,
  schema: JsonSchema,
  cacheKey: string
): ValidateFunction {
  const cached = validatorCache.get(cacheKey)
  if (cached) return cached

  const validator = ajv.compile(
    normalizeExclusiveBounds({
      ...schema,
      components: spec.components,
    }) as JsonSchema
  )
  validatorCache.set(cacheKey, validator)
  return validator
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return '(no error detail)'
  return errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim()).join('; ')
}
