import {
  CredentialDetailSchema,
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
