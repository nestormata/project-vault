import { z } from 'zod/v4'
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_FREQUENCIES,
  NOTIFICATION_SEVERITIES,
} from '@project-vault/shared'

export const PreferenceItemSchema = z.object({
  alertType: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_.]+$/, 'alertType must be lowercase alphanumeric with dots and underscores'),
  channel: z.enum([...NOTIFICATION_CHANNELS, 'none'] as [string, ...string[]]),
  frequency: z.enum(NOTIFICATION_FREQUENCIES),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES),
})

export const PreferenceOutputItemSchema = z.object({
  alertType: z.string(),
  channel: z.enum(NOTIFICATION_CHANNELS),
  frequency: z.enum(NOTIFICATION_FREQUENCIES),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES),
})

export const PutPreferencesBodySchema = z
  .array(PreferenceItemSchema)
  .max(200, 'Maximum 200 preference entries')
  .superRefine((items, ctx) => {
    const seen = new Set<string>()
    for (const [i, item] of items.entries()) {
      const key = `${item.alertType}:${item.channel}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate alertType+channel combination: ${item.alertType} / ${item.channel}`,
          path: [i],
        })
      }
      seen.add(key)
    }
  })

export const PatchPreferencesBodySchema = z
  .array(PreferenceItemSchema)
  .min(1, 'At least one preference entry required for PATCH')
  .max(200)

export const GetPreferencesResponseSchema = z.object({
  data: z.array(PreferenceOutputItemSchema),
})

export const RoutingItemSchema = z.object({
  alertType: z.string().min(1).max(100),
  routeTo: z.enum(['owner', 'admin', 'member']),
})

export const PutRoutingBodySchema = z
  .array(RoutingItemSchema)
  .max(100, 'Maximum 100 routing entries')

export const GetRoutingResponseSchema = z.object({
  data: z.array(RoutingItemSchema),
})

export const GetInboxQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['unread', 'read', 'all']).default('all'),
})

export const InboxEntrySchema = z.object({
  id: z.string().uuid(),
  alertType: z.string(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  projectId: z.string().nullable(),
  resourceId: z.string().nullable(),
  resourceType: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
})

export const InboxEntryIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
})

export const GetInboxResponseSchema = z.object({
  data: z.array(InboxEntrySchema),
  page: z.number(),
  limit: z.number(),
})
