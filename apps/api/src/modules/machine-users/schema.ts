import {
  ApiKeyIssuedSchema,
  ApiKeyMetadataSchema,
  MachineUserDetailSchema,
  MachineUserRoleSchema,
  MachineUserSummarySchema,
  MAX_MACHINE_USER_LIST_OFFSET,
  type ApiKeyIssued,
  type ApiKeyMetadata,
  type MachineUserDetail,
  type MachineUserSummary,
} from '@project-vault/shared'
import { z } from 'zod/v4'
import { ProjectScopeParamsSchema } from '../credentials/schema.js'
import { PageLimitQueryShape } from '../../lib/pagination.js'

export { ProjectScopeParamsSchema, MAX_MACHINE_USER_LIST_OFFSET }

// AC-4: description cap matches CreateCredentialBodySchema's description field verbatim
// (modules/credentials/schema.ts:39) — no named export exists there, so the literal is
// duplicated here with this citation rather than importing across modules for one number.
const MACHINE_USER_DESCRIPTION_MAX_LENGTH = 1024

export const CreateMachineUserBodySchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    role: MachineUserRoleSchema,
    description: z.string().max(MACHINE_USER_DESCRIPTION_MAX_LENGTH).trim().nullable().optional(),
  })
  .strict()
  .meta({ id: 'CreateMachineUserBody' })

export const MachineUserParamsSchema = z
  .object({ machineUserId: z.uuid() })
  .meta({ id: 'MachineUserParams' })

export const ApiKeyParamsSchema = z
  .object({ machineUserId: z.uuid(), keyId: z.uuid() })
  .meta({ id: 'ApiKeyParams' })

export const PaginationQuerySchema = z
  .object(PageLimitQueryShape)
  .strict()
  .meta({ id: 'MachineUserPaginationQuery' })

// AC-9/AC-10: expiresAt is optional (omitted -> never expires); when present it must be a
// syntactically valid ISO-8601 timestamp (z.iso.datetime() below) strictly in the future.
export const IssueApiKeyBodySchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.expiresAt && new Date(val.expiresAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be in the future',
      })
    }
  })
  .meta({ id: 'IssueApiKeyBody' })

export const MachineUserResponseSchema = z
  .object({ data: MachineUserDetailSchema })
  .meta({ id: 'MachineUserResponse' })

export const MachineUserListResponseSchema = z
  .object({
    data: z.object({
      items: z.array(MachineUserSummarySchema),
      total: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'MachineUserListResponse' })

export const IssueApiKeyResponseSchema = z
  .object({ data: ApiKeyIssuedSchema })
  .meta({ id: 'IssueApiKeyResponse' })

export const ListApiKeysResponseSchema = z
  .object({
    data: z.object({
      items: z.array(ApiKeyMetadataSchema),
      total: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'ListApiKeysResponse' })

export const RevokeApiKeyResponseSchema = z
  .object({ data: z.object({ id: z.uuid(), revokedAt: z.iso.datetime() }) })
  .meta({ id: 'RevokeApiKeyResponse' })

export type CreateMachineUserBody = z.infer<typeof CreateMachineUserBodySchema>
export type MachineUserParams = z.infer<typeof MachineUserParamsSchema>
export type ApiKeyParams = z.infer<typeof ApiKeyParamsSchema>
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>
export type IssueApiKeyBody = z.infer<typeof IssueApiKeyBodySchema>
export type { MachineUserDetail, MachineUserSummary, ApiKeyIssued, ApiKeyMetadata }
