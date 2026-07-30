import { z } from 'zod/v4'
import { ActiveRotationBadgeSchema } from './rotations.js'

export const UpcomingRotationSchema = z
  .object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    // Story 18.5 AC-2: optional — an 'active' entry (see below) has no cron-derived due date, so
    // there is nothing meaningful to put here.
    scheduledAt: z.iso.datetime().optional(),
    // Story 18.5 AC-2/AC-3: 'active' is additive — a credential whose current rotation is in a
    // badge-worthy (non-terminal) state, surfaced instead of being silently excluded (the
    // pre-existing 'pending'/'overdue' computation, computeUpcomingRotations, still excludes
    // active-rotation credentials from ITS OWN result set unchanged; the project dashboard merges
    // these in separately — see getProjectDashboardData).
    status: z.enum(['pending', 'overdue', 'active']),
    // Present only when status === 'active'.
    activeRotation: ActiveRotationBadgeSchema.optional(),
  })
  .meta({ id: 'UpcomingRotation' })

export const RecentAccessEventSchema = z
  .object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    actorDisplayName: z.string(),
    // AC-A4: the 8 real credential.* audit event types matching AC-A1's `resource_type =
    // 'credential'` query filter (see `packages/shared/src/constants/audit-events.ts`).
    eventType: z.enum([
      'credential.created',
      'credential.version_created',
      'credential.value_revealed',
      'credential.version_purged',
      'credential.tags_updated',
      'credential.dependency_added',
      'credential.dependency_archived',
      'credential.lifecycle_updated',
    ]),
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
