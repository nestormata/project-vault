import { z } from 'zod/v4'

export const OrgUserParamsSchema = z.object({
  userId: z.uuid(),
})

export type OrgUserParams = z.infer<typeof OrgUserParamsSchema>

export const failedAuthThresholdPayloadSchema = z
  .object({
    thresholdType: z.enum(['ip', 'account']),
    thresholdCount: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
    attemptCount: z.number().int().min(1),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    ipAddress: z.string().optional(),
    userId: z.uuid().optional(),
    attemptedEmail: z.email().optional(),
  })
  .strict()

export const SecurityAlertsQuerySchema = z.object({
  status: z.enum(['PENDING_DELIVERY', 'delivered', 'dismissed', 'all']).default('all'),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const securityAlertsResponseSchema = z.object({
  data: z.object({
    items: z.array(
      z.object({
        id: z.uuid(),
        alertType: z.string(),
        severity: z.enum(['info', 'warning', 'critical']),
        status: z.enum(['PENDING_DELIVERY', 'delivered', 'dismissed']),
        payload: failedAuthThresholdPayloadSchema,
        deliveryStatus: z.enum(['pending_notification_channel', 'delivered', 'dismissed']),
        createdAt: z.iso.datetime(),
      })
    ),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    hasNext: z.boolean(),
  }),
})

export type SecurityAlertsQuery = z.infer<typeof SecurityAlertsQuerySchema>
