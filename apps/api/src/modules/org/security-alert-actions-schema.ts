import { z } from 'zod/v4'

export const DismissAlertParamsSchema = z.object({ alertId: z.uuid() })

export const DismissAlertBodySchema = z
  .object({ reason: z.string().trim().min(1).max(2048) })
  .strict()
  .meta({ id: 'DismissAlertBody' })

export const DismissAlertResponseSchema = z
  .object({
    data: z.object({ id: z.uuid(), status: z.literal('dismissed') }),
  })
  .meta({ id: 'DismissAlertResponse' })
