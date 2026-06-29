import {
  CredentialAccessEntrySchema,
  CredentialDependencySchema,
  CredentialDetailSchema,
  CredentialSummarySchema,
  CredentialValueSchema,
  CredentialVersionSummarySchema,
  ImportActionSchema,
  ImportConfirmResponseSchema,
  ImportPreviewResponseSchema,
  SystemTypeSchema,
  validateRotationCron,
} from '@project-vault/shared'
import { z } from 'zod/v4'

function rotationScheduleRefine(
  val: { rotationSchedule?: string | null | undefined },
  ctx: z.RefinementCtx
) {
  if (typeof val.rotationSchedule === 'string') {
    const res = validateRotationCron(val.rotationSchedule)
    if (!res.ok) {
      ctx.addIssue({ code: 'custom', path: ['rotationSchedule'], message: 'invalid_cron' })
    }
  }
}

export const MAX_ACTIVE_DEPENDENCIES = 200

const lifecycleFieldsSchema = z.object({
  expiresAt: z.iso.datetime().nullable().optional(),
  rotationSchedule: z.string().trim().nullable().optional(),
})

export const CreateCredentialBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    value: z.string().min(1).max(65536),
    description: z.string().max(1024).trim().nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    ...lifecycleFieldsSchema.shape,
  })
  .strict()
  .superRefine(rotationScheduleRefine)
  .meta({ id: 'CreateCredentialBody' })

export const AddVersionBodySchema = z
  .object({ value: z.string().min(1).max(65536) })
  .strict()
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
  })
  .strict()
  .meta({ id: 'AddDependencyBody' })

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
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      limit: z.number().int().positive(),
      hasNext: z.boolean(),
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

export const DependencyListResponseSchema = z
  .object({
    data: z.object({
      items: z.array(CredentialDependencySchema),
      hasDependencies: z.boolean(),
    }),
  })
  .meta({ id: 'DependencyListResponse' })

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

export { ImportPreviewResponseSchema, ImportConfirmResponseSchema }

export type ImportConfirmBody = z.infer<typeof ImportConfirmBodySchema>
