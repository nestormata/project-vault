import { z } from 'zod/v4'
import { UpcomingRotationSchema } from './dashboard.js'

export const ExpiringCredentialItemSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    projectId: z.uuid(),
    projectName: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'ExpiringCredentialItem' })

export const OrgDashboardSchema = z
  .object({
    totalCredentials: z.number().int().nonnegative(),
    expiringWithin30Days: z.object({
      count: z.number().int().nonnegative(),
      items: z.array(ExpiringCredentialItemSchema),
    }),
    projectsWithOverdueRotations: z.object({
      count: z.number().int().nonnegative(),
      items: z.array(UpcomingRotationSchema),
    }),
    unresolvedAlertCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'OrgDashboard' })

export type ExpiringCredentialItem = z.infer<typeof ExpiringCredentialItemSchema>
export type OrgDashboard = z.infer<typeof OrgDashboardSchema>
