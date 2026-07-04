import {
  CompleteRotationBodySchema,
  ConfirmChecklistItemBodySchema,
  FailChecklistItemBodySchema,
  RetryChecklistItemBodySchema,
  RotationChecklistItemSchema,
  RotationChecklistItemStatusSchema,
  RotationDetailSchema,
  RotationStatusSchema,
  RotationSummarySchema,
  UpcomingRotationSchema,
  UpcomingRotationsQuerySchema,
} from '@project-vault/shared'
import { z } from 'zod/v4'
import { PageLimitQueryShape } from '../../lib/pagination.js'

export {
  CompleteRotationBodySchema,
  ConfirmChecklistItemBodySchema,
  FailChecklistItemBodySchema,
  RetryChecklistItemBodySchema,
  UpcomingRotationsQuerySchema,
}

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
  .object(PageLimitQueryShape)
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

// Story 5.2 — checklist item mutation routes (extends 5.1's params/response schema set)
export const RotationChecklistItemParamsSchema = z
  .object({
    projectId: z.uuid(),
    credentialId: z.uuid(),
    rotationId: z.uuid(),
    itemId: z.uuid(),
  })
  .meta({ id: 'RotationChecklistItemParams' })

const ChecklistItemMutationResultSchema = z.object({
  data: z.object({
    item: RotationChecklistItemSchema,
    rotationVersion: z.number().int().positive(),
  }),
})

export const ConfirmChecklistItemResponseSchema = ChecklistItemMutationResultSchema.meta({
  id: 'ConfirmChecklistItemResponse',
})
export const FailChecklistItemResponseSchema = ChecklistItemMutationResultSchema.meta({
  id: 'FailChecklistItemResponse',
})
export const RetryChecklistItemResponseSchema = ChecklistItemMutationResultSchema.meta({
  id: 'RetryChecklistItemResponse',
})

export const CompleteRotationResponseSchema = z
  .object({ data: RotationDetailSchema })
  .meta({ id: 'CompleteRotationResponse' })

export const UpcomingRotationsResponseSchema = z
  .object({ data: z.object({ items: z.array(UpcomingRotationSchema) }) })
  .meta({ id: 'UpcomingRotationsResponse' })

// AC-3: confirming an already-confirmed item — carries the original evidentiary record so a
// client can decide whether to treat this as an idempotent success.
export const AlreadyConfirmedResponseSchema = z
  .object({
    code: z.literal('already_confirmed'),
    message: z.string(),
    confirmedBy: z.uuid().nullable(),
    confirmedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AlreadyConfirmedResponse' })

// AC-5/AC-7: fail/retry called against an item not in the expected prior state. Carries
// lastActedBy/lastActedAt so a client that lost its own prior response can tell "I already did
// this" apart from "someone else raced me" (see AC-5's idempotent-retry guidance).
export const InvalidItemStatusResponseSchema = z
  .object({
    code: z.literal('invalid_item_status'),
    message: z.string(),
    currentStatus: RotationChecklistItemStatusSchema,
    lastActedBy: z.uuid().nullable(),
    lastActedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'InvalidItemStatusResponse' })

// AC-3: confirm/fail/retry against a rotation that is no longer in_progress.
export const RotationNotActiveResponseSchema = z
  .object({
    code: z.literal('rotation_not_active'),
    message: z.string(),
    status: RotationStatusSchema,
  })
  .meta({ id: 'RotationNotActiveResponse' })

// AC-8: advisory-lock contention or a lost CAS race.
export const ConcurrentModificationResponseSchema = z
  .object({
    code: z.literal('concurrent_modification'),
    message: z.string(),
    currentVersion: z.number().int().nonnegative(),
  })
  .meta({ id: 'ConcurrentModificationResponse' })

// AC-7: the retry that pushed retryCount to the cap — item transitions to
// max_retries_exceeded as a side effect even though the request itself is rejected.
export const MaxRetriesExceededResponseSchema = z
  .object({
    code: z.literal('max_retries_exceeded'),
    message: z.string(),
    retryCount: z.number().int().nonnegative(),
    maxRetries: z.number().int().positive(),
  })
  .meta({ id: 'MaxRetriesExceededResponse' })

// AC-10: complete blocked because at least one item is not confirmed.
export const ChecklistIncompleteResponseSchema = z
  .object({
    code: z.literal('checklist_incomplete'),
    message: z.string(),
    pendingItems: z.array(
      z.object({
        id: z.uuid(),
        systemName: z.string(),
        status: RotationChecklistItemStatusSchema,
      })
    ),
  })
  .meta({ id: 'ChecklistIncompleteResponse' })

// AC-11: zero-dependency rotation completed without the acknowledgement flag.
export const AcknowledgementRequiredResponseSchema = z
  .object({
    code: z.literal('acknowledgement_required'),
    message: z.string(),
    checklistItemCount: z.literal(0),
  })
  .meta({ id: 'AcknowledgementRequiredResponse' })

export type InitiateRotationBody = z.infer<typeof InitiateRotationBodySchema>
export type RotationParams = z.infer<typeof RotationParamsSchema>
export type RotationCredentialParams = z.infer<typeof RotationCredentialParamsSchema>
export type ListRotationsQuery = z.infer<typeof ListRotationsQuerySchema>
export type RotationChecklistItemParams = z.infer<typeof RotationChecklistItemParamsSchema>
export type ConfirmChecklistItemBody = z.infer<typeof ConfirmChecklistItemBodySchema>
export type FailChecklistItemBody = z.infer<typeof FailChecklistItemBodySchema>
export type RetryChecklistItemBody = z.infer<typeof RetryChecklistItemBodySchema>
export type CompleteRotationBody = z.infer<typeof CompleteRotationBodySchema>
export type UpcomingRotationsQuery = z.infer<typeof UpcomingRotationsQuerySchema>
