import { z } from 'zod/v4'

export const NotificationChannelResultSchema = z.enum(['delivered', 'failed', 'not_configured'])

export const NotificationTestResponseSchema = z.object({
  email: NotificationChannelResultSchema,
  slack: NotificationChannelResultSchema,
})

export type NotificationTestResponse = z.infer<typeof NotificationTestResponseSchema>
