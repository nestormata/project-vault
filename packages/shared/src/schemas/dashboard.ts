import { z } from 'zod/v4'

export const UpcomingRotationSchema = z
  .object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    scheduledAt: z.iso.datetime(),
    status: z.enum(['pending', 'overdue']),
  })
  .meta({ id: 'UpcomingRotation' })

export const RecentAccessEventSchema = z
  .object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    actorDisplayName: z.string(),
    eventType: z.enum(['credential.value_revealed', 'credential.created', 'credential.updated']),
    occurredAt: z.iso.datetime(),
  })
  .meta({ id: 'RecentAccessEvent' })

export const ProjectDashboardSchema = z
  .object({
    credentialStats: z.object({
      active: z.number().int().nonnegative(),
      expiringSoon: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
    }),
    upcomingRotations: z.array(UpcomingRotationSchema),
    monitoredServiceHealth: z.object({
      healthy: z.number().int().nonnegative(),
      degraded: z.number().int().nonnegative(),
      down: z.number().int().nonnegative(),
    }),
    recentAccessEvents: z.array(RecentAccessEventSchema),
    unresolvedAlertCount: z.number().int().nonnegative(),
    isEmpty: z.boolean(),
    suggestedActions: z.array(z.enum(['add_credential', 'add_service', 'import_credentials'])),
  })
  .meta({ id: 'ProjectDashboard' })

export type UpcomingRotation = z.infer<typeof UpcomingRotationSchema>
export type RecentAccessEvent = z.infer<typeof RecentAccessEventSchema>
export type ProjectDashboard = z.infer<typeof ProjectDashboardSchema>

export const ProjectDashboardPreviewSchema = ProjectDashboardSchema
export type ProjectDashboardPreview = ProjectDashboard

export const EMPTY_PROJECT_DASHBOARD: ProjectDashboard = {
  credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
  upcomingRotations: [],
  monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
  recentAccessEvents: [],
  unresolvedAlertCount: 0,
  isEmpty: true,
  suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
}

export const EMPTY_PROJECT_DASHBOARD_PREVIEW = EMPTY_PROJECT_DASHBOARD
