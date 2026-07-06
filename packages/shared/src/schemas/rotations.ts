import { z } from 'zod/v4'

/** Shared by InitiateRotationBodySchema (api/schema.ts, 5.1) and ConfirmChecklistItemBodySchema
 *  below: an optional free-text notes field that treats whitespace-only input the same as
 *  omitted input (both become `null`) rather than persisting an empty/whitespace string. */
export function optionalTrimmedNotes(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .trim()
    .nullable()
    .optional()
    .transform((v) => (v ? v : null))
}

export const RotationStatusSchema = z.enum([
  'in_progress',
  'completed',
  'abandoned',
  'stale_recovery',
  'break_glass_complete',
])

export const RotationChecklistItemStatusSchema = z.enum([
  'unconfirmed',
  'confirmed',
  'failed',
  'max_retries_exceeded',
])

export const RotationChecklistItemSchema = z
  .object({
    id: z.uuid(),
    dependencyId: z.uuid().nullable(),
    systemName: z.string(),
    status: RotationChecklistItemStatusSchema,
    confirmedBy: z.uuid().nullable(),
    confirmedAt: z.iso.datetime().nullable(),
    retryCount: z.number().int().nonnegative(),
    retryScheduledAt: z.iso.datetime().nullable(),
    lastFailureReason: z.string().nullable(),
    lastActedBy: z.uuid().nullable(),
    lastActedAt: z.iso.datetime().nullable(),
    notes: z.string().nullable().optional(),
  })
  .meta({ id: 'RotationChecklistItem' })

// Story 5.3 AC-2/AC-5: present only on a break-glass rotation's response — describes the
// superseded (previous) version's purge-protected overlap window (CR1's non-blocking
// "emergency overlap" design, not the immediate-retirement PRD text — see ADR-5.3-01).
export const RotationPreviousVersionOverlapSchema = z
  .object({
    versionNumber: z.number().int().positive(),
    breakGlassOverlapExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'RotationPreviousVersionOverlap' })

export const RotationDetailSchema = z
  .object({
    id: z.uuid(),
    credentialId: z.uuid(),
    projectId: z.uuid(),
    status: RotationStatusSchema,
    version: z.number().int().positive(),
    initiatedBy: z.uuid().nullable(),
    initiatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    notes: z.string().nullable(),
    sameValueAsPrevious: z.boolean().optional(),
    checklistItems: z.array(RotationChecklistItemSchema),
    previousVersionOverlap: RotationPreviousVersionOverlapSchema.optional(),
    // Story 5.5 AC-4 code-review fix: present (true) only on a break-glass response that was
    // short-circuited as a duplicate of a very recent prior call — lets the caller tell a
    // deduped replay apart from a fresh success, since a second, genuinely different incident
    // responder's newValue/reason is silently discarded on a dedup and would otherwise look
    // identical to a real success in the response body.
    deduped: z.boolean().optional(),
  })
  .meta({ id: 'RotationDetail' })

export const RotationSummarySchema = z
  .object({
    id: z.uuid(),
    status: RotationStatusSchema,
    initiatedBy: z.uuid().nullable(),
    initiatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    itemCount: z.number().int().nonnegative(),
    confirmedCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'RotationSummary' })

export const ConfirmChecklistItemBodySchema = z
  .object({
    notes: optionalTrimmedNotes(1024),
  })
  .strict()
  .meta({ id: 'ConfirmChecklistItemBody' })

export const FailChecklistItemBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(1024),
    retryScheduledAt: z.iso.datetime().nullable().optional(),
  })
  .strict()
  .meta({ id: 'FailChecklistItemBody' })

// An explicit empty object — {} is the only valid body (omitting the body entirely is also
// accepted by parseBody, per the same Fastify+Zod convention as other bodyless-intent POSTs).
export const RetryChecklistItemBodySchema = z.object({}).strict().meta({
  id: 'RetryChecklistItemBody',
})

export const CompleteRotationBodySchema = z
  .object({
    acknowledgedNoDependencies: z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'CompleteRotationBody' })

export const UpcomingRotationsQuerySchema = z
  .object({
    horizon: z.enum(['7d', '30d', '90d']).default('30d'),
  })
  .strict()
  .meta({ id: 'UpcomingRotationsQuery' })

export type ConfirmChecklistItemBody = z.infer<typeof ConfirmChecklistItemBodySchema>
export type FailChecklistItemBody = z.infer<typeof FailChecklistItemBodySchema>
export type RetryChecklistItemBody = z.infer<typeof RetryChecklistItemBodySchema>
export type CompleteRotationBody = z.infer<typeof CompleteRotationBodySchema>
export type UpcomingRotationsQuery = z.infer<typeof UpcomingRotationsQuerySchema>

export type RotationStatus = z.infer<typeof RotationStatusSchema>
export type RotationChecklistItemStatus = z.infer<typeof RotationChecklistItemStatusSchema>
export type RotationChecklistItem = z.infer<typeof RotationChecklistItemSchema>
export type RotationDetail = z.infer<typeof RotationDetailSchema>
export type RotationPreviousVersionOverlap = z.infer<typeof RotationPreviousVersionOverlapSchema>
export type RotationSummary = z.infer<typeof RotationSummarySchema>
