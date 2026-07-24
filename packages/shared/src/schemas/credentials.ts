import { z } from 'zod/v4'
import {
  CREDENTIAL_TEMPLATES,
  FIELD_KEY_PATTERN,
  FIELD_KEY_MAX_LENGTH,
  FIELD_VALUE_MAX_LENGTH,
  MAX_FIELDS_PER_SECRET,
} from '../credential-templates.js'

// Story 13.2 — structured multi-field secrets.
export const CredentialTemplateSchema = z
  .enum(CREDENTIAL_TEMPLATES)
  .meta({ id: 'CredentialTemplate' })

const FieldKeySchema = z
  .string()
  .trim()
  .min(1, { message: 'Field key is required' })
  .max(FIELD_KEY_MAX_LENGTH, {
    message: `Field key must be at most ${FIELD_KEY_MAX_LENGTH} characters`,
  })
  .regex(FIELD_KEY_PATTERN, {
    message: 'Field key may only contain letters, numbers, spaces, and _ . -',
  })

/** A single named field carrying its value (used in create/edit request bodies and the reveal
 *  response). `value` may be empty (a blank field is allowed). */
export const FieldSchema = z
  .object({
    key: FieldKeySchema,
    value: z.string().max(FIELD_VALUE_MAX_LENGTH),
    sensitive: z.boolean(),
  })
  .strict()
  .meta({ id: 'Field' })

/** Plaintext field metadata — NEVER carries a value. Persisted to the unencrypted
 *  `credential_versions.field_meta` JSONB column and returned in detail responses. */
export const FieldMetaSchema = z
  .object({
    key: FieldKeySchema,
    sensitive: z.boolean(),
    template: CredentialTemplateSchema.optional(),
  })
  .strict()
  .meta({ id: 'FieldMeta' })

/** A field-set array as accepted in a create/edit body: at least one field, capped at the
 *  per-secret limit. (Custom template starts empty client-side but must reach >=1 before save.) */
export const FieldArraySchema = z
  .array(FieldSchema)
  .min(1, { message: 'A secret must have at least one field' })
  .max(MAX_FIELDS_PER_SECRET, {
    message: `A secret may have at most ${MAX_FIELDS_PER_SECRET} fields`,
  })

export type Field = z.infer<typeof FieldSchema>
export type FieldMeta = z.infer<typeof FieldMetaSchema>
// Note: `CredentialTemplate` is exported from ./credential-templates.js (the registry) — the Zod
// enum here derives from that same tuple, so we do not re-export the type to avoid a name clash.

export const CredentialDetailSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    orgId: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    expiresAt: z.iso.datetime().nullable(),
    rotationSchedule: z.string().nullable(),
    // Story 2.9 AC-L1: lifecycle edit form must pre-fill cacheable from the detail payload —
    // without this field the UI defaulted to `true` and every save could silently flip
    // `cacheable: false` credentials back to cacheable.
    cacheable: z.boolean(),
    retentionCount: z.number().int().min(1),
    currentVersionNumber: z.number().int().positive(),
    // Story 13.2 — format discriminator of the current version's value envelope. 1 = legacy
    // bare-string; 2 = structured field-set JSON envelope.
    schemaVersion: z.number().int().positive(),
    // Story 13.2 — plaintext field metadata for the current version (keys/sensitivity/template),
    // never values. For a legacy schema_version=1 secret this is a single unnamed default field.
    fields: z.array(FieldMetaSchema),
    createdBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'CredentialDetail' })

/** Story 13.2 — reveal response for a structured secret: every field with its (decrypted) value.
 *  For a legacy secret this is a single default field wrapping the bare string. */
export const CredentialFieldsValueSchema = z
  .object({
    fields: z.array(FieldSchema),
    schemaVersion: z.number().int().positive(),
    versionNumber: z.number().int().positive(),
    retrievedAt: z.iso.datetime(),
  })
  .meta({ id: 'CredentialFieldsValue' })

export const CredentialValueSchema = z
  .object({
    value: z.string(),
    versionNumber: z.number().int().positive(),
    retrievedAt: z.iso.datetime(),
  })
  .meta({ id: 'CredentialValue' })

export const CredentialVersionSummarySchema = z
  .object({
    versionNumber: z.number().int().positive(),
    createdBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    isCurrent: z.boolean(),
    purgedAt: z.iso.datetime().nullable(),
    // Story 5.3 AC-14: set when this version was abandoned (either via a manual `abandon` call
    // on a stale_recovery rotation, or superseded by a break-glass call) — additive alongside
    // purgedAt, distinct signal ("never validated as good" vs. "cryptographically purged").
    abandonedAt: z.iso.datetime().nullable(),
    // Story 13.2 — value-envelope format of this version (1 = legacy bare string, 2 = field-set).
    schemaVersion: z.number().int().positive(),
  })
  .meta({ id: 'CredentialVersionSummary' })

export const CredentialStatusSchema = z.enum(['active', 'expiring', 'expired'])

export const CredentialSummarySchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    status: CredentialStatusSchema,
    expiresAt: z.iso.datetime().nullable(),
    rotationSchedule: z.string().nullable(),
    currentVersionNumber: z.number().int().positive(),
    hasDependencies: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'CredentialSummary' })

export type CredentialDetail = z.infer<typeof CredentialDetailSchema>
export type CredentialValue = z.infer<typeof CredentialValueSchema>
export type CredentialFieldsValue = z.infer<typeof CredentialFieldsValueSchema>
export type CredentialVersionSummary = z.infer<typeof CredentialVersionSummarySchema>
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>
export type CredentialSummary = z.infer<typeof CredentialSummarySchema>
