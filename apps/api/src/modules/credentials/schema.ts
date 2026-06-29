import {
  CredentialDetailSchema,
  CredentialSummarySchema,
  CredentialValueSchema,
  CredentialVersionSummarySchema,
} from '@project-vault/shared'
import { z } from 'zod/v4'

function hasFiveCronFields(value: string): boolean {
  // Structural 5-field check only; full cron semantics land in Story 2.4.
  const fields = value
    .trim()
    .split(' ')
    .filter((field) => field.length > 0)
  return fields.length === 5
}

export const CreateCredentialBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    value: z.string().min(1).max(65536), // value is NEVER trimmed (whitespace may be significant)
    description: z.string().max(1024).trim().nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    rotationSchedule: z.string().refine(hasFiveCronFields, 'invalid_cron').nullable().optional(),
  })
  .strict()
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

export type CreateCredentialBody = z.infer<typeof CreateCredentialBodySchema>
export type AddVersionBody = z.infer<typeof AddVersionBodySchema>
export type CredentialParams = z.infer<typeof CredentialParamsSchema>
export type ProjectScopeParams = z.infer<typeof ProjectScopeParamsSchema>
export type ListCredentialsQuery = z.infer<typeof ListCredentialsQuerySchema>
export type TagArrayBody = z.infer<typeof TagArrayBodySchema>
