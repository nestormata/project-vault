import {
  CredentialAccessEntrySchema,
  CredentialDependencySchema,
  CredentialDetailSchema,
  CredentialSummarySchema,
  CredentialTemplateSchema,
  CredentialValueSchema,
  CredentialVersionSummarySchema,
  FieldArraySchema,
  ImportActionSchema,
  SystemTypeSchema,
  validateRotationCron,
} from '@project-vault/shared'
import { z } from 'zod/v4'
import { paginatedListMetaFields } from '../../lib/api-contracts.js'

function rotationScheduleRefine(val: { rotationSchedule?: string | null }, ctx: z.RefinementCtx) {
  if (typeof val.rotationSchedule === 'string') {
    const res = validateRotationCron(val.rotationSchedule)
    if (!res.ok) {
      ctx.addIssue({ code: 'custom', path: ['rotationSchedule'], message: 'invalid_cron' })
    }
  }
}

// AC-3: ADR-2.10-03 — runtime `new URL()` parsing (never a regex/prefix check) is the
// authoritative "is this a well-formed absolute URL" signal; the protocol allowlist check runs
// on the PARSED `.protocol` value, not the raw string, so leading whitespace/control characters
// or protocol-relative tricks can't bypass it.
const LINK_URL_ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

function isHttpUrl(value: string): boolean {
  try {
    return LINK_URL_ALLOWED_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

// Shared by AddDependencyBodySchema and PatchDependencyBodySchema. Trims before validating/
// storing; a whitespace-only value is normalized to `null` (not stored as an empty string).
// Absent (`undefined`) and explicit `null` pass through untouched — the caller's `.strict()`
// object shape + rawBody `in` checks (PATCH) are what distinguish "absent" from "explicit null".
const linkUrlFieldSchema = z
  .string()
  .trim()
  .max(2048)
  .nullable()
  .optional()
  .transform((val) => {
    if (val === undefined || val === null) return val
    return val === '' ? null : val
  })

function linkUrlRefine(val: { linkUrl?: string | null }, ctx: z.RefinementCtx) {
  if (typeof val.linkUrl === 'string' && !isHttpUrl(val.linkUrl)) {
    ctx.addIssue({ code: 'custom', path: ['linkUrl'], message: 'invalid_link_url' })
  }
}

export const MAX_ACTIVE_DEPENDENCIES = 200

const lifecycleFieldsSchema = z.object({
  expiresAt: z.iso.datetime().nullable().optional(),
  rotationSchedule: z.string().trim().nullable().optional(),
  // Story 7.2 D7 — opt-out of the offline agent's local cache for high-sensitivity credentials.
  cacheable: z.boolean().optional(),
})

const createCredentialCommonShape = {
  name: z.string().trim().min(1).max(256),
  description: z.string().max(1024).trim().nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  ...lifecycleFieldsSchema.shape,
}

// Legacy single-value create shape (backward compatible — existing API/CLI clients, AC-5 regression
// guard). Preserved as one variant of a discriminated union rather than coerced into the field-set
// shape.
const CreateCredentialLegacyBodySchema = z
  .object({
    ...createCredentialCommonShape,
    value: z.string().min(1).max(65536),
  })
  .strict()
  .superRefine(rotationScheduleRefine)

// Story 13.2 — structured field-set create shape. `template` is enum-constrained to the 5 known
// values (unknown value → 422, never silently treated as custom); it may be omitted entirely.
const CreateCredentialFieldSetBodySchema = z
  .object({
    ...createCredentialCommonShape,
    template: CredentialTemplateSchema.optional(),
    fields: FieldArraySchema,
  })
  .strict()
  .superRefine(rotationScheduleRefine)

export const CreateCredentialBodySchema = z
  .union([CreateCredentialFieldSetBodySchema, CreateCredentialLegacyBodySchema])
  .meta({ id: 'CreateCredentialBody' })

const AddVersionLegacyBodySchema = z.object({ value: z.string().min(1).max(65536) }).strict()
const AddVersionFieldSetBodySchema = z
  .object({
    template: CredentialTemplateSchema.optional(),
    fields: FieldArraySchema,
  })
  .strict()

export const AddVersionBodySchema = z
  .union([AddVersionFieldSetBodySchema, AddVersionLegacyBodySchema])
  .meta({ id: 'AddVersionBody' })

export const CredentialParamsSchema = z
  .object({ projectId: z.uuid(), credentialId: z.uuid() })
  .meta({ id: 'CredentialParams' })
export const ProjectScopeParamsSchema = z
  .object({ projectId: z.uuid() })
  .meta({ id: 'ProjectScopeParams' })

export const DependencyParamsSchema = z
  .object({ projectId: z.uuid(), credentialId: z.uuid(), dependencyId: z.uuid() })
  .meta({ id: 'DependencyParams' })

export const ListCredentialsQuerySchema = z
  .object({
    q: z.string().trim().max(256).optional(),
    tags: z.string().max(1024).optional(),
    status: z.enum(['active', 'expiring', 'expired']).optional(),
    expiresWithin: z.coerce.number().int().min(1).max(3650).default(30),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .meta({ id: 'ListCredentialsQuery' })
export const MAX_CREDENTIAL_LIST_OFFSET = 10_000

export const TagArrayBodySchema = z
  .object({
    tags: z.array(z.string().trim().min(1).max(50)).max(20),
  })
  .strict()
  .meta({ id: 'TagArrayBody' })

export const AddDependencyBodySchema = z
  .object({
    systemName: z.string().trim().min(1).max(256),
    systemType: SystemTypeSchema.optional(),
    notes: z.string().trim().max(2048).nullable().optional(),
    linkUrl: linkUrlFieldSchema,
  })
  .strict()
  .superRefine(linkUrlRefine)
  .meta({ id: 'AddDependencyBody' })

// AC-3.2/3.4 (ADR-2.10-04): narrowly scoped to `linkUrl` only — systemName/systemType/notes stay
// immutable-after-create (archive-and-recreate remains the only path to change them). Absent →
// unchanged, value → set, `null` → clear (same three-state semantics as the credential-lifecycle
// PATCH, disambiguated via the handler's `rawBody` check, not by this schema alone).
export const PatchDependencyBodySchema = z
  .object({
    linkUrl: linkUrlFieldSchema,
  })
  .strict()
  .superRefine(linkUrlRefine)
  .meta({ id: 'PatchDependencyBody' })

export const ListDependenciesQuerySchema = z
  .object({
    includeArchived: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict()
  .transform((val) => ({ includeArchived: val.includeArchived ?? false }))
  .meta({ id: 'ListDependenciesQuery' })

export const UpdateCredentialLifecycleBodySchema = lifecycleFieldsSchema
  .strict()
  .superRefine(rotationScheduleRefine)
  .meta({ id: 'UpdateCredentialLifecycleBody' })

export const CredentialDetailResponseSchema = z
  .object({ data: CredentialDetailSchema })
  .meta({ id: 'CredentialDetailResponse' })
export const CredentialValueResponseSchema = z
  .object({ data: CredentialValueSchema })
  .meta({ id: 'CredentialValueResponse' })
export const CredentialVersionListResponseSchema = z
  .object({
    data: z.object({ items: z.array(CredentialVersionSummarySchema) }),
  })
  .meta({ id: 'CredentialVersionListResponse' })

export const ListCredentialsResponseSchema = z
  .object({
    data: z.object({
      items: z.array(CredentialSummarySchema),
      ...paginatedListMetaFields,
    }),
  })
  .meta({ id: 'ListCredentialsResponse' })

export const TagUpdateResponseSchema = z
  .object({ data: z.object({ id: z.uuid(), tags: z.array(z.string()) }) })
  .meta({ id: 'TagUpdateResponse' })

export const AddVersionResponseSchema = z
  .object({
    data: z.object({
      credentialId: z.uuid(),
      versionNumber: z.number().int().positive(),
      createdAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'AddVersionResponse' })

export const DependencyResponseSchema = z
  .object({ data: CredentialDependencySchema })
  .meta({ id: 'DependencyResponse' })

// AC-5: the confirmation status of the credential's currently-`staged` rotation's checklist item
// for a given dependency, if any. `status` mirrors rotation_checklist_items.status verbatim
// (unconfirmed/confirmed/failed/max_retries_exceeded — Story 5.1/5.2's actual enum, not the
// illustrative 'pending' used in the story stub prose).
export const DependencyChecklistStatusSchema = z
  .object({
    rotationId: z.uuid(),
    itemId: z.uuid(),
    status: z.enum(['unconfirmed', 'confirmed', 'failed', 'max_retries_exceeded']),
    confirmedBy: z.uuid().nullable(),
    confirmedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'DependencyChecklistStatus' })

export const DependencyWithChecklistStatusSchema = CredentialDependencySchema.extend({
  checklistStatus: DependencyChecklistStatusSchema.nullable(),
}).meta({ id: 'DependencyWithChecklistStatus' })

export const DependencyListResponseSchema = z
  .object({
    data: z.object({
      items: z.array(DependencyWithChecklistStatusSchema),
      hasDependencies: z.boolean(),
      hasStagedRotation: z.boolean(),
    }),
  })
  .meta({ id: 'DependencyListResponse' })

export const DependencyPatchResponseSchema = z
  .object({
    data: z.object({
      id: z.uuid(),
      linkUrl: z.url().nullable(),
      updatedAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'DependencyPatchResponse' })

export const DependencyArchivedResponseSchema = z
  .object({
    data: z.object({
      id: z.uuid(),
      credentialId: z.uuid(),
      archivedAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'DependencyArchivedResponse' })

export const CredentialLifecycleResponseSchema = z
  .object({
    data: z.object({
      id: z.uuid(),
      expiresAt: z.iso.datetime().nullable(),
      rotationSchedule: z.string().nullable(),
      cacheable: z.boolean(),
      updatedAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'CredentialLifecycleResponse' })

export const CredentialAccessListResponseSchema = z
  .object({
    data: z.object({ items: z.array(CredentialAccessEntrySchema) }),
  })
  .meta({ id: 'CredentialAccessListResponse' })

export type CreateCredentialBody = z.infer<typeof CreateCredentialBodySchema>
export type AddVersionBody = z.infer<typeof AddVersionBodySchema>
export type CredentialParams = z.infer<typeof CredentialParamsSchema>
export type ProjectScopeParams = z.infer<typeof ProjectScopeParamsSchema>
export type ListCredentialsQuery = z.infer<typeof ListCredentialsQuerySchema>
export type TagArrayBody = z.infer<typeof TagArrayBodySchema>
export type AddDependencyBody = z.infer<typeof AddDependencyBodySchema>
export type PatchDependencyBody = z.infer<typeof PatchDependencyBodySchema>
export type ListDependenciesQuery = z.infer<typeof ListDependenciesQuerySchema>
export type UpdateCredentialLifecycleBody = z.infer<typeof UpdateCredentialLifecycleBodySchema>

export const ImportErrorResponseSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    limit: z.number().int().optional(),
    found: z.number().int().optional(),
    limitBytes: z.number().int().optional(),
    supportedExtensions: z.array(z.string()).optional(),
    expiredAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'ImportErrorResponse' })

export const ImportExpiredResponseSchema = ImportErrorResponseSchema

export const ImportParamsSchema = z.object({ projectId: z.uuid() }).meta({ id: 'ImportParams' })

export const ImportConfirmParamsSchema = z
  .object({ projectId: z.uuid() })
  .meta({ id: 'ImportConfirmParams' })

export const ImportConfirmBodySchema = z
  .object({
    importId: z.uuid(),
    defaultAction: ImportActionSchema,
    overrides: z.record(z.string(), ImportActionSchema).optional(),
  })
  .strict()
  .meta({ id: 'ImportConfirmBody' })

export { ImportPreviewResponseSchema, ImportConfirmResponseSchema } from '@project-vault/shared'

export type ImportConfirmBody = z.infer<typeof ImportConfirmBodySchema>
