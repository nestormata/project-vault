// Story 13.2 — structured multi-field secret write/read helpers.
//
// The encrypted `fields` envelope is stored in the EXISTING `credential_versions.encrypted_value`
// column: for schema_version = 2 rows it is the ciphertext of `JSON.stringify(Field[])`; for
// legacy schema_version = 1 rows it is the bare plaintext string (never re-encrypted, never
// re-parsed). `field_meta` is the separate plaintext JSONB column holding key/sensitivity/template
// only — NEVER values.
import {
  DEFAULT_FIELD_KEY,
  normalizeFieldKey,
  type CredentialTemplate,
  type Field,
  type FieldMeta,
} from '@project-vault/shared'

/** Thrown by the service layer when two field keys collide case-insensitively (AC-3). Mapped to a
 *  `409 field_key_conflict` by the route, before any write — the failed request has zero side
 *  effects and emits no audit event (AC-9). */
export class FieldKeyConflictError extends Error {
  constructor(public readonly conflictingKey: string) {
    super('field_key_conflict')
    this.name = 'FieldKeyConflictError'
  }
}

type CreateBodyish = {
  value?: string
  fields?: Field[]
  template?: CredentialTemplate
}

export function isFieldSetBody(body: CreateBodyish): body is {
  fields: Field[]
  template?: CredentialTemplate
} {
  return Array.isArray(body.fields)
}

/**
 * Rejects duplicate field keys (case-insensitive, trimmed, NFC-normalized) against the FINAL field
 * set being saved. Uses a `Set` (never a plain object literal keyed by user input) so a literal
 * `"__proto__"`/`"constructor"` key cannot pollute a prototype chain. Uniqueness is checked against
 * the final set only — removing a key and re-adding it under the same name in one save is allowed.
 */
export function assertUniqueFieldKeys(fields: Field[]): void {
  const seen = new Set<string>()
  for (const field of fields) {
    const norm = normalizeFieldKey(field.key)
    if (seen.has(norm)) throw new FieldKeyConflictError(field.key)
    seen.add(norm)
  }
}

export type ResolvedFieldSet = {
  fields: Field[]
  template?: CredentialTemplate
}

/**
 * Turns a create/edit body into the field set to persist. A `{ fields }` body is validated for
 * key uniqueness; a legacy `{ value }` body synthesizes exactly one default field (AC-5). Keys are
 * already trimmed by the shared `FieldSchema`.
 */
export function resolveFieldSet(body: CreateBodyish): ResolvedFieldSet {
  if (isFieldSetBody(body)) {
    assertUniqueFieldKeys(body.fields)
    return {
      fields: body.fields.map((f) => ({ key: f.key, value: f.value, sensitive: f.sensitive })),
      template: body.template,
    }
  }
  return {
    fields: [{ key: DEFAULT_FIELD_KEY, value: body.value ?? '', sensitive: true }],
  }
}

/** Plaintext field metadata for `credential_versions.field_meta` — keys/sensitivity/template only,
 *  never values. */
export function buildFieldMeta(resolved: ResolvedFieldSet): FieldMeta[] {
  return resolved.fields.map((f) => ({
    key: f.key,
    sensitive: f.sensitive,
    ...(resolved.template ? { template: resolved.template } : {}),
  }))
}

/** The plaintext that gets encrypted into `encrypted_value` for a schema_version = 2 row. */
export function serializeFieldEnvelope(resolved: ResolvedFieldSet): string {
  return JSON.stringify(
    resolved.fields.map((f) => ({ key: f.key, value: f.value, sensitive: f.sensitive }))
  )
}

/** Field metadata for a detail response. Legacy (schema_version = 1, or null field_meta) wraps
 *  into a single unnamed default field — pixel-identical to the pre-Phase-2 single-value UI. */
export function fieldMetaForResponse(schemaVersion: number, fieldMeta: unknown): FieldMeta[] {
  if (schemaVersion >= 2 && Array.isArray(fieldMeta)) {
    return fieldMeta as FieldMeta[]
  }
  return [{ key: DEFAULT_FIELD_KEY, sensitive: true }]
}

/**
 * Unwraps a decrypted plaintext for the legacy single-`value` reveal endpoint. Legacy rows and
 * single-default-field v2 rows return the bare value (backward compatible with existing API/CLI
 * clients); a genuine multi-field v2 row returns the full JSON envelope string.
 */
export function unwrapRevealValue(schemaVersion: number, plaintext: string): string {
  if (schemaVersion < 2) return plaintext
  const fields = parseEnvelope(plaintext)
  if (fields.length === 1 && fields[0]?.key === DEFAULT_FIELD_KEY) {
    return fields[0].value
  }
  return plaintext
}

/** Parses a decrypted plaintext into the full field set (with values). Legacy rows wrap the bare
 *  string into a single default field. */
export function parseFieldsFromPlaintext(schemaVersion: number, plaintext: string): Field[] {
  if (schemaVersion < 2) {
    return [{ key: DEFAULT_FIELD_KEY, value: plaintext, sensitive: true }]
  }
  return parseEnvelope(plaintext)
}

function parseEnvelope(plaintext: string): Field[] {
  const parsed: unknown = JSON.parse(plaintext)
  if (!Array.isArray(parsed)) throw new Error('Field envelope is not a JSON array')
  return parsed.map((raw) => {
    const f = raw as Record<string, unknown>
    return {
      key: String(f.key),
      value: typeof f.value === 'string' ? f.value : '',
      sensitive: Boolean(f.sensitive),
    }
  })
}

/** Diff of old→new field keys for the audit payload (AC-9). A rename surfaces as one added + one
 *  removed key; values never appear. */
export function computeFieldDelta(
  oldKeys: string[],
  newKeys: string[]
): { addedFields: string[]; removedFields: string[] } {
  const oldSet = new Set(oldKeys.map(normalizeFieldKey))
  const newSet = new Set(newKeys.map(normalizeFieldKey))
  return {
    addedFields: newKeys.filter((k) => !oldSet.has(normalizeFieldKey(k))),
    removedFields: oldKeys.filter((k) => !newSet.has(normalizeFieldKey(k))),
  }
}
