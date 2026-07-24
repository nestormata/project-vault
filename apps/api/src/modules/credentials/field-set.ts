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

/** Thrown when a legacy `{ value }` edit/import body would silently collapse an existing
 *  multi-field secret down to a single default field. The legacy shape exists for backward
 *  compatibility with clients that predate multi-field secrets (AC-5) — it must never be usable to
 *  destroy an already-multi-field secret's other fields. Mapped to a `422` by the route, before any
 *  write — no side effects, no audit event. */
export class LegacyShapeFieldLossError extends Error {
  constructor() {
    super('legacy_shape_field_loss')
    this.name = 'LegacyShapeFieldLossError'
  }
}

/** Guards the legacy `{ value }` edit/import shape against silently discarding an existing
 *  multi-field secret's other fields (see `LegacyShapeFieldLossError`). A secret only ever counts
 *  as "already multi-field" when it has more than one field, or its single field isn't the
 *  untemplated default key — a single default-keyed field is exactly what the legacy shape itself
 *  produces, so re-saving it via the legacy shape is a safe no-op, not data loss. */
export function assertLegacyShapeSafe(isLegacyBody: boolean, currentKeys: string[]): void {
  if (!isLegacyBody) return
  const isAlreadyMultiField =
    currentKeys.length > 1 || (currentKeys[0] !== undefined && currentKeys[0] !== DEFAULT_FIELD_KEY)
  if (isAlreadyMultiField) throw new LegacyShapeFieldLossError()
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
 * Unwraps a decrypted plaintext for the legacy single-`value` reveal endpoint. Legacy rows and any
 * single-field v2 row (regardless of the field's key — e.g. the `api_key` template's `key` field or
 * the `secure_note` template's `note` field, not just the untemplated default `value` key) return
 * the bare value (backward compatible with existing API/CLI clients); only a genuine multi-field v2
 * row returns the full JSON envelope string.
 */
export function unwrapRevealValue(schemaVersion: number, plaintext: string): string {
  if (schemaVersion < 2) return plaintext
  const fields = parseEnvelope(plaintext)
  if (fields.length === 1 && fields[0]) {
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

/** Diff of old→new field keys for the audit payload (AC-9). Keys present in both sets (after
 *  normalization) are unchanged and omitted. When exactly one key disappears and exactly one key
 *  appears, it is reported as a rename (`renamedFields: [{ from, to }]`) per AC-9's positive
 *  example — otherwise the changes are reported as plain adds/removes. Values never appear. */
export function computeFieldDelta(
  oldKeys: string[],
  newKeys: string[]
): {
  addedFields: string[]
  removedFields: string[]
  renamedFields: Array<{ from: string; to: string }>
} {
  const oldSet = new Set(oldKeys.map((k) => normalizeFieldKey(k)))
  const newSet = new Set(newKeys.map((k) => normalizeFieldKey(k)))
  const added = newKeys.filter((k) => !oldSet.has(normalizeFieldKey(k)))
  const removed = oldKeys.filter((k) => !newSet.has(normalizeFieldKey(k)))

  const [addedKey] = added
  const [removedKey] = removed
  if (
    added.length === 1 &&
    removed.length === 1 &&
    addedKey !== undefined &&
    removedKey !== undefined
  ) {
    return {
      addedFields: [],
      removedFields: [],
      renamedFields: [{ from: removedKey, to: addedKey }],
    }
  }
  return { addedFields: added, removedFields: removed, renamedFields: [] }
}
