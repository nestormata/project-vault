import { z } from 'zod/v4'
import { ApiErrorSchema } from '../../lib/api-contracts.js'

// Story 28.9 D7: the export file's PLAINTEXT (post-decryption) payload version — distinct from
// `EncryptedValue.version` (packages/crypto/src/types.ts), which only versions the AES-GCM
// envelope shape. This versions the meaning of the decrypted JSON structure itself. Bumping this
// is a breaking format change; this story ships only version 1.
export const EXPORT_FORMAT_VERSION = 1 as const

// Story 28.9 AC-3 Red Team round: hard caps on every collection in the payload, checked by Zod
// BEFORE any database write begins, so a validly-encrypted-but-maliciously-shaped file (the
// attacker already had the real key, per the Elicitation Log) cannot exhaust import-time
// resources. Sized generously above any real project's plausible size (mirrors
// `pending_imports.item_count`'s existing BETWEEN 0 AND 500 precedent, scaled up since a whole-
// project export legitimately has many more rows than a single bulk-secret-import batch).
export const MAX_IMPORT_CREDENTIALS = 2000
export const MAX_VERSIONS_PER_CREDENTIAL = 1000
export const MAX_DEPENDENCIES = 5000
export const MAX_ROTATIONS = 5000
export const MAX_CHECKLIST_ITEMS_PER_ROTATION = 200
export const MAX_CERT_RECORDS = 2000
export const MAX_DOMAIN_RECORDS = 2000
export const MAX_SERVICE_ENDPOINTS = 2000
export const MAX_STATUS_PAGES = 1
export const MAX_STATUS_PAGE_SERVICES = 2000
export const MAX_MACHINE_USERS = 2000

const nullableIsoString = z.string().max(64).nullable()

const ExportCredentialVersionSchema = z
  .object({
    versionNumber: z.number().int().min(1),
    schemaVersion: z.number().int().min(1).max(1000),
    fieldMeta: z.unknown().nullable(),
    // `null` = this version was already cryptographically purged (retention job) at export time
    // — there is no value to carry across; the version's existence (and history) is still
    // preserved, just with no plaintext, mirroring the source row's own purged state.
    value: z.string().max(1_000_000).nullable(),
    promoted: z.boolean(),
    createdAt: nullableIsoString,
  })
  .strict()

const ExportCredentialSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(2048).nullable(),
    tags: z.array(z.string().max(64)).max(64),
    expiresAt: nullableIsoString,
    alertLeadDays: z.array(z.number().int()).max(16),
    notifiedLeadDays: z.array(z.number().int()).max(16),
    rotationSchedule: z.string().max(256).nullable(),
    retentionCount: z.number().int().min(1).max(1000),
    cacheable: z.boolean(),
    createdAt: nullableIsoString,
    // The versionNumber of this credential's exported version list that was "current" at export
    // time — `null` only for the (practically unreachable) zero-version edge case.
    currentVersionNumber: z.number().int().min(1).nullable(),
    versions: z.array(ExportCredentialVersionSchema).max(MAX_VERSIONS_PER_CREDENTIAL),
  })
  .strict()

const ExportDependencySchema = z
  .object({
    // Index into the top-level `credentials` array — never a raw source-instance UUID (D1).
    credentialIndex: z.number().int().min(0),
    systemName: z.string().min(1).max(256),
    // Code review fix (28.9): must match `credential_dependencies_system_type_check`
    // (packages/db/src/schema/credential-dependencies.ts) exactly — a bare `z.string()` let a
    // malformed-but-validly-encrypted file pass this gate and throw a raw DB CHECK-constraint
    // error deep inside the import transaction instead of a clean 422 at the schema boundary.
    systemType: z.enum(['service', 'ci_pipeline', 'database', 'third_party', 'other']),
    notes: z.string().max(2048).nullable(),
    linkUrl: z.string().max(2048).nullable(),
    fieldKey: z.string().max(256).nullable(),
  })
  .strict()

const ExportChecklistItemSchema = z
  .object({
    systemName: z.string().max(256),
    // Code review fix (28.9): matches `rotation_checklist_items_status_check` exactly — see
    // `systemType`'s comment above for why a bare string here is a schema-boundary gap.
    status: z.enum(['unconfirmed', 'confirmed', 'failed', 'max_retries_exceeded']),
    confirmedAt: nullableIsoString,
    notes: z.string().max(2048).nullable(),
    retryCount: z.number().int().min(0).max(100_000),
    lastFailureReason: z.string().max(2048).nullable(),
    lastActedAt: nullableIsoString,
  })
  .strict()

const ExportRotationSchema = z
  .object({
    credentialIndex: z.number().int().min(0),
    newVersionNumber: z.number().int().min(1),
    previousVersionNumber: z.number().int().min(1),
    // Story 28.9 D5/AC-6: the export serializer coerces any non-terminal status
    // ('in_progress' | 'staged' | 'stale_recovery') to 'completed' before this field is ever
    // written — see service.ts's `coerceRotationStatusForExport`. No live rotation state machine
    // is ever running for an imported project, so no imported row is ever allowed to read as one
    // of those non-terminal values.
    // Code review fix (28.9): matches `rotations_status_check` exactly (full state-machine list,
    // not just the terminal values D5 coerces to on export) — a bare string here let a
    // malformed-but-validly-encrypted file pass the schema gate and throw a raw DB CHECK-
    // constraint error mid-transaction instead of a clean 422.
    status: z.enum([
      'in_progress',
      'staged',
      'promoted',
      'retired',
      'completed',
      'abandoned',
      'stale_recovery',
      'break_glass_complete',
    ]),
    initiatedAt: nullableIsoString,
    completedAt: nullableIsoString,
    promotedAt: nullableIsoString,
    retiredAt: nullableIsoString,
    notes: z.string().max(2048).nullable(),
    targetFields: z.array(z.string().max(256)).max(64).nullable(),
    checklistItems: z.array(ExportChecklistItemSchema).max(MAX_CHECKLIST_ITEMS_PER_ROTATION),
  })
  .strict()

// Shared by cert/domain export records: both track the same alert-lead-day bookkeeping alongside
// their own identity/expiry fields.
const leadDaysArraySchema = z.array(z.number().int()).max(16)

const ExportCertRecordSchema = z
  .object({
    domain: z.string().min(1).max(256),
    expiresAt: nullableIsoString,
    alertLeadDays: leadDaysArraySchema,
    notifiedLeadDays: leadDaysArraySchema,
  })
  .strict()

const ExportDomainRecordSchema = z
  .object({
    domainName: z.string().min(1).max(256),
    renewalDate: nullableIsoString,
    alertLeadDays: leadDaysArraySchema,
    notifiedLeadDays: leadDaysArraySchema,
  })
  .strict()

const ExportServiceEndpointSchema = z
  .object({
    name: z.string().min(1).max(256),
    url: z.string().min(1).max(2048),
    checkFrequencyMinutes: z.number().int(),
    downThresholdFailures: z.number().int(),
  })
  .strict()

const ExportStatusPageServiceSchema = z
  .object({
    // Index into the top-level `serviceEndpoints` array.
    serviceIndex: z.number().int().min(0),
    displayName: z.string().min(1).max(100),
    sortOrder: z.number().int(),
  })
  .strict()

const ExportStatusPageSchema = z
  .object({
    services: z.array(ExportStatusPageServiceSchema).max(MAX_STATUS_PAGE_SERVICES),
  })
  .strict()

const ExportMachineUserSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(2048).nullable(),
    // Code review fix (28.9): matches `machine_users_role_check` exactly — see the
    // `credentialDependencies.systemType` comment above for why a bare string here is a
    // schema-boundary gap.
    role: z.enum(['member', 'viewer']),
  })
  .strict()

// AC-3: validated in full, BEFORE any database write, once `exportFormatVersion` itself has
// already been confirmed supported (see import-service.ts — that check happens first and
// separately, per D7's "fail loudly on the format boundary before interpreting anything else").
export const ExportBundleSchema = z
  .object({
    exportFormatVersion: z.literal(EXPORT_FORMAT_VERSION),
    project: z
      .object({
        name: z.string().min(1).max(128),
        description: z.string().max(512).nullable(),
        tags: z.array(z.string().max(64)).max(64),
      })
      .strict(),
    credentials: z.array(ExportCredentialSchema).max(MAX_IMPORT_CREDENTIALS),
    // AC-7/D5: this type intentionally has no `credentialShares`/share-derived field anywhere —
    // not a stripped-down variant, absent entirely. Do not add one.
    credentialDependencies: z.array(ExportDependencySchema).max(MAX_DEPENDENCIES),
    rotations: z.array(ExportRotationSchema).max(MAX_ROTATIONS),
    certRecords: z.array(ExportCertRecordSchema).max(MAX_CERT_RECORDS),
    domainRecords: z.array(ExportDomainRecordSchema).max(MAX_DOMAIN_RECORDS),
    serviceEndpoints: z.array(ExportServiceEndpointSchema).max(MAX_SERVICE_ENDPOINTS),
    statusPages: z.array(ExportStatusPageSchema).max(MAX_STATUS_PAGES),
    machineUsers: z.array(ExportMachineUserSchema).max(MAX_MACHINE_USERS),
  })
  .strict()

export type ExportBundle = z.infer<typeof ExportBundleSchema>
export type ExportCredential = z.infer<typeof ExportCredentialSchema>
export type ExportRotation = z.infer<typeof ExportRotationSchema>

export const ExportProjectParamsSchema = z.object({ projectId: z.uuid() }).meta({
  id: 'ExportProjectParams',
})

export const ImportProjectResponseSchema = z
  .object({
    data: z.object({
      projectId: z.uuid(),
      name: z.string(),
      importedCounts: z.record(z.string(), z.number()),
    }),
  })
  .meta({ id: 'ImportProjectResponse' })

export const ExportErrorSchema = ApiErrorSchema
