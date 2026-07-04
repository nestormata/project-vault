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

export type RotationStatus = z.infer<typeof RotationStatusSchema>
export type RotationChecklistItemStatus = z.infer<typeof RotationChecklistItemStatusSchema>
export type RotationChecklistItem = z.infer<typeof RotationChecklistItemSchema>
export type RotationDetail = z.infer<typeof RotationDetailSchema>
export type RotationSummary = z.infer<typeof RotationSummarySchema>
