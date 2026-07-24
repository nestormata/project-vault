// Story 13.2 — Structured multi-field secret templates.
//
// SINGLE SOURCE OF TRUTH for the five built-in credential templates' field sets. Consumed by
// both `apps/api` (server-side default-field synthesis + `template` enum validation) and
// `apps/web` (client-side template-selector rendering). The API and web MUST NOT independently
// hardcode these field lists — a drift here (e.g. web adds a field the API doesn't validate) is
// exactly the inconsistency this shared registry exists to prevent (see story Dev Notes).

export const CREDENTIAL_TEMPLATES = [
  'login',
  'db_connection',
  'api_key',
  'secure_note',
  'custom',
] as const

export type CredentialTemplate = (typeof CREDENTIAL_TEMPLATES)[number]

export type TemplateFieldDef = {
  key: string
  sensitive: boolean
}

/**
 * Ordered field sets for each template. Order matters — it drives deterministic form/test/
 * screenshot rendering — so it is defined explicitly here, not derived. Authoritative per
 * Story 13.2 AC-1 / AC-2.
 */
export const CREDENTIAL_TEMPLATE_FIELDS: Record<CredentialTemplate, readonly TemplateFieldDef[]> = {
  login: [
    { key: 'username', sensitive: false },
    { key: 'password', sensitive: true },
  ],
  db_connection: [
    { key: 'host', sensitive: false },
    { key: 'port', sensitive: false },
    { key: 'database', sensitive: false },
    { key: 'username', sensitive: false },
    { key: 'password', sensitive: true },
  ],
  api_key: [{ key: 'key', sensitive: true }],
  // A free-text note still uses the field-set model (one field) rather than the legacy
  // single-value path, so it gets a field_meta entry like any other Phase-2 secret.
  secure_note: [{ key: 'note', sensitive: true }],
  // Zero fields at selection time — the user must add at least one before save. Distinct from the
  // "no template selected" path (AC-5), which synthesizes exactly one default field automatically.
  custom: [],
}

export const CREDENTIAL_TEMPLATE_LABELS: Record<CredentialTemplate, string> = {
  login: 'Login',
  db_connection: 'Database Connection',
  api_key: 'API Key',
  secure_note: 'Secure Note',
  custom: 'Custom',
}

/**
 * The canonical single default field key used for (a) a create request with no template and no
 * `fields` array (legacy `{ value }` shape, AC-5) and (b) a legacy `schema_version = 1` row
 * wrapped into the field-set response shape at serialization time (AC-7). Must be identical in
 * both paths so a legacy secret edited for the first time keeps a stable field key.
 */
export const DEFAULT_FIELD_KEY = 'value'

/** Generous but bounded cap on fields per secret — guards against an unbounded field_meta/fields
 *  envelope (storage + UI-rendering DoS vector). */
export const MAX_FIELDS_PER_SECRET = 50

/** Field keys are user-supplied and become JSONB object/array keys and in-memory lookup keys.
 *  Constrain to a safe charset: alphanumerics, underscore, dot, hyphen, and space. 1–64 chars. */
export const FIELD_KEY_PATTERN = /^[a-zA-Z0-9_.\- ]{1,64}$/
export const FIELD_KEY_MAX_LENGTH = 64
export const FIELD_VALUE_MAX_LENGTH = 65536

/**
 * Normalizes a field key for case-insensitive uniqueness comparison: trim whitespace, apply NFC
 * Unicode normalization (so visually-identical but byte-different composed/decomposed forms
 * collide), then lowercase. Used both client-side (immediate duplicate affordance) and server-side
 * (authoritative 409 check). MUST be applied identically on both sides.
 */
export function normalizeFieldKey(key: string): string {
  return key.trim().normalize('NFC').toLowerCase()
}

/** Returns the ordered default field set for a template (empty for `custom`). */
export function templateFields(template: CredentialTemplate): TemplateFieldDef[] {
  return CREDENTIAL_TEMPLATE_FIELDS[template].map((f) => ({ ...f }))
}
