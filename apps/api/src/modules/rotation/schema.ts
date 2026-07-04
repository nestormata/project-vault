import { RotationDetailSchema, RotationSummarySchema } from '@project-vault/shared'
import { z } from 'zod/v4'

export const InitiateRotationBodySchema = z
  .object({
    newValue: z.string().min(1).max(65536),
    notes: z
      .string()
      .max(1024)
      .trim()
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .strict()
  .meta({ id: 'InitiateRotationBody' })

export const RotationParamsSchema = z
  .object({ projectId: z.uuid(), credentialId: z.uuid(), rotationId: z.uuid() })
  .meta({ id: 'RotationParams' })

export const RotationCredentialParamsSchema = z
  .object({ projectId: z.uuid(), credentialId: z.uuid() })
  .meta({ id: 'RotationCredentialParams' })

export const ListRotationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .meta({ id: 'ListRotationsQuery' })

export const InitiateRotationResponseSchema = z
  .object({ data: RotationDetailSchema })
  .meta({ id: 'InitiateRotationResponse' })

export const RotationDetailResponseSchema = z
  .object({ data: RotationDetailSchema })
  .meta({ id: 'RotationDetailResponse' })

export const RotationHistoryResponseSchema = z
  .object({
    data: z.object({
      items: z.array(RotationSummarySchema),
      page: z.number().int().positive(),
      limit: z.number().int().positive(),
      total: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    }),
  })
  .meta({ id: 'RotationHistoryResponse' })

// AC-5: the 409 rotation-in-progress body carries `rotationId` alongside the standard `{ code,
// message }` envelope — a dedicated schema (not the generic ApiErrorSchema) so the Fastify/Zod
// response serializer doesn't strip the extra field.
export const RotationConflictResponseSchema = z
  .object({
    code: z.literal('rotation_in_progress'),
    message: z.string(),
    rotationId: z.uuid().nullable(),
  })
  .meta({ id: 'RotationConflictResponse' })

export type InitiateRotationBody = z.infer<typeof InitiateRotationBodySchema>
export type RotationParams = z.infer<typeof RotationParamsSchema>
export type RotationCredentialParams = z.infer<typeof RotationCredentialParamsSchema>
export type ListRotationsQuery = z.infer<typeof ListRotationsQuerySchema>
