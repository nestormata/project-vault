// Story 13.2 — structured multi-field secret write/read helpers.
//
// The encrypted `fields` envelope is stored in the EXISTING `credential_versions.encrypted_value`
// column: for schema_version = 2 rows it is the ciphertext of `JSON.stringify(Field[])`; for
// legacy schema_version = 1 rows it is the bare plaintext string (never re-encrypted, never
// re-parsed). `field_meta` is the separate plaintext JSONB column holding key/sensitivity/template
// only — NEVER values.
import {
  DEFAULT_FIELD_KEY,
  FIELD_KINDS,
  normalizeFieldKey,
  type CredentialTemplate,
  type Field,
  type FieldKind,
  type FieldMeta,
} from '@project-vault/shared'
import { assertValidTotpSeeds, TotpSeedRequiredError } from './totp-field.js'

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

/** The kind a field is persisted with: `text` is the default and is never written, so a credential
 *  that uses no new kind stores byte-for-byte what it stored before Story 72.10. */
function storedKind(kind: FieldKind | undefined): { kind?: Exclude<FieldKind, 'text'> } {
  return kind !== undefined && kind !== 'text' ? { kind } : {}
}

/**
 * Turns a create/edit body into the field set to persist. A `{ fields }` body is validated for
 * key uniqueness; a legacy `{ value }` body synthesizes exactly one default field (AC-5). Keys are
 * already trimmed by the shared `FieldSchema`.
 *
 * Story 72.10: a `totp` field is always sensitive. Its seed is write-only, so an edit cannot send
 * it back: an EMPTY seed on a `totp` field means "keep the stored one" and is filled from
 * `previousFields` (the current version, decrypted in memory by the caller). With nothing to keep,
 * or with a seed that cannot produce codes, the write fails before any side effect.
 */
export function resolveFieldSet(
  body: CreateBodyish,
  previousFields: Field[] | null = null
): ResolvedFieldSet {
  if (isFieldSetBody(body)) {
    assertUniqueFieldKeys(body.fields)
    const fields: Field[] = body.fields.map((item) => {
      const isTotp = item.kind === 'totp'
      return {
        key: item.key,
        value: isTotp && item.value === '' ? keptTotpSeed(item.key, previousFields) : item.value,
        sensitive: isTotp ? true : item.sensitive,
        ...storedKind(item.kind),
      }
    })
    assertValidTotpSeeds(fields)
    return { fields, template: body.template }
  }
  return {
    fields: [{ key: DEFAULT_FIELD_KEY, value: body.value ?? '', sensitive: true }],
  }
}

function keptTotpSeed(name: string, previousFields: Field[] | null): string {
  const wanted = normalizeFieldKey(name)
  const previous = previousFields?.find(
    (item) => item.kind === 'totp' && normalizeFieldKey(item.key) === wanted
  )
  if (!previous || previous.value === '') throw new TotpSeedRequiredError(name)
  return previous.value
}

/** Plaintext field metadata for `credential_versions.field_meta` — keys/sensitivity/template only,
 *  never values. */
export function buildFieldMeta(resolved: ResolvedFieldSet): FieldMeta[] {
  return resolved.fields.map((f) => ({
    key: f.key,
    sensitive: f.sensitive,
    ...(resolved.template ? { template: resolved.template } : {}),
    ...storedKind(f.kind),
  }))
}

/** The plaintext that gets encrypted into `encrypted_value` for a schema_version = 2 row. */
export function serializeFieldEnvelope(resolved: ResolvedFieldSet): string {
  return JSON.stringify(
    resolved.fields.map((f) => ({
      key: f.key,
      value: f.value,
      sensitive: f.sensitive,
      ...storedKind(f.kind),
    }))
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
      ...storedKind(parseKind(f.kind)),
    }
  })
}

function parseKind(raw: unknown): FieldKind | undefined {
  return FIELD_KINDS.find((kind) => kind === raw)
}

/** Story 72.10: the fields a read may hand out. A `totp` seed is write-only, so those fields are
 *  dropped here: this is the single choke point for the reveal route, the share adapters and the
 *  machine-user credential read, which all go through `revealCurrentValue`. */
export function withoutTotpFields(fields: Field[]): Field[] {
  return fields.filter((item) => item.kind !== 'totp')
}

/** Story 72.10: the plaintext of a stored version with every `totp` seed blanked, for the project
 *  export. The field stays (key, sensitivity, kind) so an import knows a seed has to be re-entered;
 *  only the seed is withheld. Legacy rows have no kinds and are returned as they are. */
export function plaintextWithoutTotpSeeds(schemaVersion: number, plaintext: string): string {
  if (schemaVersion < 2) return plaintext
  const fields = parseEnvelope(plaintext)
  if (!fields.some((item) => item.kind === 'totp')) return plaintext
  return serializeFieldEnvelope({
    fields: fields.map((item) => (item.kind === 'totp' ? { ...item, value: '' } : item)),
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

/** Story 72.8 (P6): the keys present in BOTH field sets (after normalization) whose value differs,
 *  for the `changedFields` entry of the `credential.version_created` audit payload. The server
 *  compares in memory and returns key names only: neither value is stored, logged or returned.
 *  A key that was added, removed or renamed is reported by `computeFieldDelta`, not here. */
export function computeChangedFields(oldFields: Field[], newFields: Field[]): string[] {
  const oldValues = new Map(oldFields.map((item) => [normalizeFieldKey(item.key), item.value]))
  return newFields
    .filter((item) => {
      const before = oldValues.get(normalizeFieldKey(item.key))
      return before !== undefined && before !== item.value
    })
    .map((item) => item.key)
}
