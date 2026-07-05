import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentials, projects, securityAlerts } from '@project-vault/db/schema'
import type { OrgDashboard, ProjectDashboard } from '@project-vault/shared'
import { computeUpcomingRotations, serializeUpcomingRotation } from '../rotation/service.js'

export { computeUpcomingRotations }

const EXPIRED_FILTER = sql`${credentials.expiresAt} IS NOT NULL AND ${credentials.expiresAt} <= now()`
const EXPIRING_FILTER = sql`${credentials.expiresAt} IS NOT NULL AND ${credentials.expiresAt} > now() AND ${credentials.expiresAt} <= now() + make_interval(days => 30)`
const ACTIVE_FILTER = sql`NOT (${EXPIRED_FILTER}) AND NOT (${EXPIRING_FILTER})`

export type ProjectCredentialStats = {
  credentialCount: number
  expiringCount: number
  active: number
  expiringSoon: number
  expired: number
}

const EMPTY_PROJECT_STATS: ProjectCredentialStats = {
  credentialCount: 0,
  expiringCount: 0,
  active: 0,
  expiringSoon: 0,
  expired: 0,
}

function toProjectCredentialStats(row: {
  credentialCount: number
  expiringCount: number
  active: number
  expiringSoon: number
  expired: number
}): ProjectCredentialStats {
  return {
    credentialCount: Number(row.credentialCount),
    expiringCount: Number(row.expiringCount),
    active: Number(row.active),
    expiringSoon: Number(row.expiringSoon),
    expired: Number(row.expired),
  }
}

export function lookupProjectStats(
  statsByProject: Map<string, ProjectCredentialStats>,
  projectId: string
): ProjectCredentialStats {
  return statsByProject.get(projectId) ?? EMPTY_PROJECT_STATS
}

export async function getBatchedProjectCredentialStats(
  tx: Tx,
  projectIds: string[]
): Promise<Map<string, ProjectCredentialStats>> {
  if (projectIds.length === 0) return new Map()

  const rows = await tx
    .select({
      projectId: credentials.projectId,
      credentialCount: sql<number>`count(*)::int`,
      expiringCount: sql<number>`count(*) filter (where ${EXPIRING_FILTER})::int`,
      active: sql<number>`count(*) filter (where ${ACTIVE_FILTER})::int`,
      expiringSoon: sql<number>`count(*) filter (where ${EXPIRING_FILTER})::int`,
      expired: sql<number>`count(*) filter (where ${EXPIRED_FILTER})::int`,
    })
    .from(credentials)
    .where(inArray(credentials.projectId, projectIds))
    .groupBy(credentials.projectId)

  return new Map(rows.map((row) => [row.projectId, toProjectCredentialStats(row)] as const))
}

/**
 * Org-admin aggregate of undismissed security_alerts — not the same metric as the
 * per-user notification_inbox unread count on the nav badge (ADR-3.4-05).
 */
export async function getUnresolvedSecurityAlertCount(tx: Tx): Promise<number> {
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(securityAlerts)
    .where(ne(securityAlerts.status, 'dismissed'))
  return Number(count)
}

function buildProjectDashboard(
  stats: ProjectCredentialStats,
  unresolvedAlertCount: number,
  upcomingRotations: ProjectDashboard['upcomingRotations']
): ProjectDashboard {
  const monitoredServiceHealth = { healthy: 0, degraded: 0, down: 0 }
  const credentialTotal = stats.active + stats.expiringSoon + stats.expired
  const serviceTotal =
    monitoredServiceHealth.healthy + monitoredServiceHealth.degraded + monitoredServiceHealth.down
  // Story 5.2 AC-15: a project with zero credentials/services can never have an upcoming
  // rotation (rotations only exist for credentials that exist) — isEmpty/suggestedActions
  // deliberately do not factor upcomingRotations in.
  const isEmpty = credentialTotal === 0 && serviceTotal === 0

  return {
    credentialStats: {
      active: stats.active,
      expiringSoon: stats.expiringSoon,
      expired: stats.expired,
    },
    upcomingRotations,
    monitoredServiceHealth,
    recentAccessEvents: [],
    // ADR-3.4-01: security_alerts has no project_id — project dashboard mirrors the
    // org-wide unresolved count until Epic 6 project-scoped monitoring alerts exist.
    unresolvedAlertCount,
    isEmpty,
    suggestedActions: isEmpty ? ['add_credential', 'add_service', 'import_credentials'] : [],
  }
}

// Story 5.2 AC-15: fixed 30-day default horizon — the dashboard is a fixed summary view, not a
// filterable list (no query-param horizon here, unlike GET .../rotations/upcoming).
const PROJECT_DASHBOARD_ROTATION_HORIZON_DAYS = 30

// Code-review fix: match the org dashboard's 20-item cap on projectsWithOverdueRotations.items
// (below) — this list was previously returned unbounded, an inconsistent and unnecessary
// payload-size/pagination gap versus the adjacent org-dashboard slice.
const PROJECT_DASHBOARD_UPCOMING_ROTATIONS_LIMIT = 20

export async function getProjectDashboardData(
  tx: Tx,
  projectId: string
): Promise<ProjectDashboard> {
  const [statsByProject, unresolvedAlertCount, upcomingRotationResults] = await Promise.all([
    getBatchedProjectCredentialStats(tx, [projectId]),
    getUnresolvedSecurityAlertCount(tx),
    computeUpcomingRotations(tx, {
      projectId,
      horizonDays: PROJECT_DASHBOARD_ROTATION_HORIZON_DAYS,
    }),
  ])
  return buildProjectDashboard(
    lookupProjectStats(statsByProject, projectId),
    unresolvedAlertCount,
    upcomingRotationResults
      .slice(0, PROJECT_DASHBOARD_UPCOMING_ROTATIONS_LIMIT)
      .map(serializeUpcomingRotation)
  )
}

export async function getOrgDashboardData(tx: Tx): Promise<OrgDashboard> {
  const [{ totalCredentials } = { totalCredentials: 0 }] = await tx
    .select({ totalCredentials: sql<number>`count(*)::int` })
    .from(credentials)

  const [{ expiringCount } = { expiringCount: 0 }] = await tx
    .select({ expiringCount: sql<number>`count(*)::int` })
    .from(credentials)
    .where(EXPIRING_FILTER)

  const expiringRows =
    expiringCount === 0
      ? []
      : await tx
          .select({
            id: credentials.id,
            name: credentials.name,
            projectId: credentials.projectId,
            projectName: projects.name,
            expiresAt: credentials.expiresAt,
          })
          .from(credentials)
          .innerJoin(projects, eq(projects.id, credentials.projectId))
          .where(and(EXPIRING_FILTER, isNotNull(credentials.expiresAt)))
          .orderBy(asc(credentials.expiresAt))
          .limit(20)

  const unresolvedAlertCount = await getUnresolvedSecurityAlertCount(tx)

  // Story 5.2 AC-15: org-wide (no projectId), horizonDays: 0. Do NOT rely on the horizonDays:0
  // inclusion boundary alone to mean "overdue-only" — AC-14's inclusion rule is
  // `nextDueAt <= now + horizonDays` (inclusive) while its status label is 'overdue' only when
  // `nextDueAt < now` (strict), so a credential landing exactly at "now" would otherwise slip
  // into this bucket unlabeled as overdue. The explicit filter below is the actual gate.
  const upcomingRotationResults = await computeUpcomingRotations(tx, { horizonDays: 0 })
  const overdueRotations = upcomingRotationResults.filter((r) => r.status === 'overdue')

  return {
    totalCredentials: Number(totalCredentials),
    expiringWithin30Days: {
      count: Number(expiringCount),
      items: expiringRows.map((row) => ({
        id: row.id,
        name: row.name,
        projectId: row.projectId,
        projectName: row.projectName,
        expiresAt: row.expiresAt?.toISOString() ?? new Date(0).toISOString(),
      })),
    },
    projectsWithOverdueRotations: {
      count: overdueRotations.length,
      items: overdueRotations.slice(0, 20).map(serializeUpcomingRotation),
    },
    unresolvedAlertCount,
  }
}
