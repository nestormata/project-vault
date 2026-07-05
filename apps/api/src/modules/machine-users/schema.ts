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

// Story 7.2 AC-17 — overlapMinutes 1-1440 (24h cap), default 240 (4h). min(1) rejects 0/negative.
export const RotateApiKeyBodySchema = z
  .object({ overlapMinutes: z.number().int().min(1).max(1440).default(240) })
  .strict()
  .meta({ id: 'RotateApiKeyBody' })

export const RotateApiKeyResponseSchema = z
  .object({
    data: z.object({
      newKeyId: z.uuid(),
      key: z.string(),
      oldKeyId: z.uuid(),
      overlapExpiresAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'RotateApiKeyResponse' })

export const EmergencyRevokeResponseSchema = z
  .object({
    data: z.object({
      revokedKeyId: z.uuid(),
      newKey: z.string(),
      newKeyId: z.uuid(),
    }),
  })
  .meta({ id: 'EmergencyRevokeResponse' })

export const ExtendDormancyBodySchema = z
  .object({ days: z.number().int().min(1).max(365) })
  .strict()
  .meta({ id: 'ExtendDormancyBody' })

export const ExtendDormancyResponseSchema = z
  .object({
    data: z.object({ keyId: z.uuid(), dormancySnoozedUntil: z.iso.datetime() }),
  })
  .meta({ id: 'ExtendDormancyResponse' })

// Story 7.2 AC-23 — archival guard closure read endpoint.
export const ActiveMachineUserKeysResponseSchema = z
  .object({
    data: z.object({
      items: z.array(z.object({ machineUserId: z.uuid(), keyId: z.uuid() })),
      total: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'ActiveMachineUserKeysResponse' })

export type CreateMachineUserBody = z.infer<typeof CreateMachineUserBodySchema>
export type MachineUserParams = z.infer<typeof MachineUserParamsSchema>
export type ApiKeyParams = z.infer<typeof ApiKeyParamsSchema>
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>
export type IssueApiKeyBody = z.infer<typeof IssueApiKeyBodySchema>
export type { MachineUserDetail, MachineUserSummary, ApiKeyIssued, ApiKeyMetadata }
