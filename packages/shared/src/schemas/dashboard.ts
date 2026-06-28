import { z } from 'zod/v4'

export const ProjectDashboardPreviewSchema = z
  .object({
    credentialStats: z.object({
      active: z.number().int().nonnegative(),
      expiringSoon: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
    }),
    upcomingRotations: z.array(z.never()),
    monitoredServiceHealth: z.object({
      healthy: z.number().int().nonnegative(),
      degraded: z.number().int().nonnegative(),
      down: z.number().int().nonnegative(),
    }),
    recentAccessEvents: z.array(z.never()),
    unresolvedAlertCount: z.number().int().nonnegative(),
    isEmpty: z.literal(true),
    suggestedActions: z.array(z.enum(['add_credential', 'add_service', 'import_credentials'])),
  })
  .meta({ id: 'ProjectDashboardPreview' })

export type ProjectDashboardPreview = z.infer<typeof ProjectDashboardPreviewSchema>

export const EMPTY_PROJECT_DASHBOARD_PREVIEW: ProjectDashboardPreview = {
  credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
  upcomingRotations: [],
  monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
  recentAccessEvents: [],
  unresolvedAlertCount: 0,
  isEmpty: true,
  suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
}
