import {
  CompleteRotationBodySchema,
  ConfirmChecklistItemBodySchema,
  FailChecklistItemBodySchema,
  optionalTrimmedNotes,
  PromoteRotationBodySchema,
  RetireRotationBodySchema,
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
  PromoteRotationBodySchema,
  RetireRotationBodySchema,
  RetryChecklistItemBodySchema,
  UpcomingRotationsQuerySchema,
}

export const InitiateRotationBodySchema = z
  .object({
    newValue: z.string().min(1).max(65536),
    notes: optionalTrimmedNotes(1024),
    // Story 13.4 AC-1/AC-2: optional field-scoping. Omitted (or absent entirely) means
    // whole-secret rotation, byte-identical to pre-13.4 behavior (AC-7) — the same convention
    // as CredentialValueQuerySchema's optional `field`. Non-empty when present: an empty array
    // would be an ambiguous "target nothing" request, never a valid whole-secret signal (that's
    // what omitting the field entirely means).
    targetFields: z.array(z.string().trim().min(1).max(64)).min(1).optional(),
  })
  .strict()
  .meta({ id: 'InitiateRotationBody' })

// Story 5.3 AC-4: reason is REQUIRED (unlike normal initiation's optional notes) — FR108's
// audit trail depends on always having an incident reason on record.
export const BreakGlassRotationBodySchema = z
  .object({
    newValue: z.string().min(1).max(65536),
    reason: z.string().trim().min(1).max(1024),
  })
  .strict()
  .meta({ id: 'BreakGlassRotationBody' })

// Story 5.3 AC-11/AC-12: resume/abandon take no body — an explicit empty object is the only
// valid payload (same convention as RetryChecklistItemBodySchema).
export const ResumeRotationBodySchema = z.object({}).strict().meta({ id: 'ResumeRotationBody' })
export const AbandonRotationBodySchema = z.object({}).strict().meta({ id: 'AbandonRotationBody' })

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

// Story 13.4 AC-3 — a `targetFields` entry that doesn't exist on the credential's current
// field_meta. Reuses the same `unknown_field_key` code the existing `GET .../value?field=`
// route already returns (apps/api/src/modules/credentials/routes.ts:232), but as a dedicated
// schema (not the generic ApiErrorSchema) so the `field` property survives response
// serialization — same pattern as RotationConflictResponseSchema's `rotationId`.
export const UnknownFieldKeyResponseSchema = z
  .object({
    code: z.literal('unknown_field_key'),
    message: z.string(),
    field: z.string(),
  })
  .meta({ id: 'UnknownFieldKeyResponse' })

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

// Story 5.3 AC-6: credential-scoped advisory-lock contention (break-glass initiation), OR
// (AC-5/AC-6) a lost `FOR UPDATE NOWAIT` row-lock race against a concurrent 5.2 checklist
// mutation on the rotation being superseded — both map to this identical 409 shape.
export const RotationLockContentionResponseSchema = z
  .object({
    code: z.literal('rotation_lock_contention'),
    message: z.string(),
    credentialId: z.uuid(),
  })
  .meta({ id: 'RotationLockContentionResponse' })

// Story 5.6 follow-up: break-glass called while the credential already has a promoted-but-
// unretired rotation. Hard-blocked rather than auto-abandoned — the promoted rotation's new
// version is already the live/current value, so silently displacing it is never safe to do
// automatically. The caller must promote/retire (or abandon) that rotation first.
export const PromotedRotationConflictResponseSchema = z
  .object({
    code: z.literal('promoted_rotation_conflict'),
    message: z.string(),
    credentialId: z.uuid(),
    rotationId: z.uuid(),
  })
  .meta({ id: 'PromotedRotationConflictResponse' })

// Story 5.3 AC-17: resume/abandon called against a rotation whose status isn't stale_recovery.
export const RotationNotStaleResponseSchema = z
  .object({
    code: z.literal('rotation_not_stale'),
    message: z.string(),
    status: RotationStatusSchema,
  })
  .meta({ id: 'RotationNotStaleResponse' })

export const BreakGlassRotationResponseSchema = z
  .object({ data: RotationDetailSchema })
  .meta({ id: 'BreakGlassRotationResponse' })

export const ResumeRotationResponseSchema = z
  .object({ data: RotationDetailSchema })
  .meta({ id: 'ResumeRotationResponse' })

export const AbandonRotationResponseSchema = z
  .object({ data: RotationDetailSchema })
  .meta({ id: 'AbandonRotationResponse' })

// Story 5.6 AC-2/AC-6: promote/retire response + failure shapes.
export const PromoteRotationResponseSchema = z
  .object({ data: RotationDetailSchema })
  .meta({ id: 'PromoteRotationResponse' })

export const RetireRotationResponseSchema = z
  .object({ data: RotationDetailSchema })
  .meta({ id: 'RetireRotationResponse' })

export const RotationNotPromotableResponseSchema = z
  .object({
    code: z.literal('rotation_not_promotable'),
    message: z.string(),
    currentStatus: RotationStatusSchema,
  })
  .meta({ id: 'RotationNotPromotableResponse' })

export const RotationNotRetirableResponseSchema = z
  .object({
    code: z.literal('rotation_not_retirable'),
    message: z.string(),
    currentStatus: RotationStatusSchema,
  })
  .meta({ id: 'RotationNotRetirableResponse' })

// AC-6.1: soft-prompt shape shared by promote/retire — same fields as the legacy
// checklist_incomplete response, renamed/repurposed as a re-submittable prompt.
export const RotationAcknowledgementRequiredResponseSchema = z
  .object({
    code: z.literal('acknowledgement_required'),
    message: z.string(),
    pendingItems: z.array(
      z.object({
        id: z.uuid(),
        systemName: z.string(),
        status: RotationChecklistItemStatusSchema,
      })
    ),
    totalItemCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'RotationAcknowledgementRequiredResponse' })

// AC-6.4: completeRotation's legacy route, called against a rotation no longer in in_progress.
export const RotationWrongStateForLegacyCompleteResponseSchema = z
  .object({
    code: z.literal('rotation_wrong_state_for_legacy_complete'),
    message: z.string(),
    currentStatus: RotationStatusSchema,
  })
  .meta({ id: 'RotationWrongStateForLegacyCompleteResponse' })

// AC-2.5: abandon called against a `promoted` (post-promotion, pre-retirement) rotation.
export const RotationNotAbandonableAfterPromotionResponseSchema = z
  .object({
    code: z.literal('rotation_not_abandonable_after_promotion'),
    message: z.string(),
  })
  .meta({ id: 'RotationNotAbandonableAfterPromotionResponse' })

// AC-8: staged-value reveal route.
export const StagedValueResponseSchema = z
  .object({
    data: z.object({
      value: z.string(),
      versionNumber: z.number().int().positive(),
    }),
  })
  .meta({ id: 'StagedValueResponse' })

export type InitiateRotationBody = z.infer<typeof InitiateRotationBodySchema>
export type BreakGlassRotationBody = z.infer<typeof BreakGlassRotationBodySchema>
export type ResumeRotationBody = z.infer<typeof ResumeRotationBodySchema>
export type AbandonRotationBody = z.infer<typeof AbandonRotationBodySchema>
export type RotationParams = z.infer<typeof RotationParamsSchema>
export type RotationCredentialParams = z.infer<typeof RotationCredentialParamsSchema>
export type ListRotationsQuery = z.infer<typeof ListRotationsQuerySchema>
export type RotationChecklistItemParams = z.infer<typeof RotationChecklistItemParamsSchema>
export type ConfirmChecklistItemBody = z.infer<typeof ConfirmChecklistItemBodySchema>
export type FailChecklistItemBody = z.infer<typeof FailChecklistItemBodySchema>
export type RetryChecklistItemBody = z.infer<typeof RetryChecklistItemBodySchema>
export type CompleteRotationBody = z.infer<typeof CompleteRotationBodySchema>
export type UpcomingRotationsQuery = z.infer<typeof UpcomingRotationsQuerySchema>
// PromoteRotationBody/RetireRotationBody: re-exported directly from @project-vault/shared
// (below) rather than locally re-inferred, since @project-vault/shared already exports the
// identical type — avoids a near-duplicate `z.infer<...>` line jscpd would otherwise flag.
export type { PromoteRotationBody, RetireRotationBody } from '@project-vault/shared'
