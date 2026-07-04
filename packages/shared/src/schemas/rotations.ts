import { z } from 'zod/v4'

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

// Identical trim/transform idiom to InitiateRotationBodySchema's `notes` field (5.1) — fixes
// the same whitespace-vs-null inconsistency for this story's own notes/reason fields.
export const ConfirmChecklistItemBodySchema = z
  .object({
    notes: z
      .string()
      .max(1024)
      .trim()
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
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
export type RotationSummary = z.infer<typeof RotationSummarySchema>
