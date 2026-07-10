import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentials,
  projectMemberships,
  projects,
  securityAlerts,
  serviceEndpoints,
} from '@project-vault/db/schema'
import type { OrgDashboard, ProjectDashboard } from '@project-vault/shared'
import type { OrgRole } from '../../plugins/require-org-role.js'
import { roleRank } from '../../lib/secure-route.js'
import { computeUpcomingRotations, serializeUpcomingRotation } from '../rotation/service.js'
import { getRecentAccessEventsForProject } from './recent-access-events.js'

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

export type ProjectServiceHealthStats = { healthy: number; degraded: number; down: number }

const EMPTY_SERVICE_HEALTH_STATS: ProjectServiceHealthStats = {
  healthy: 0,
  degraded: 0,
  down: 0,
}

export function lookupServiceHealthStats(
  statsByProject: Map<string, ProjectServiceHealthStats>,
  projectId: string
): ProjectServiceHealthStats {
  return statsByProject.get(projectId) ?? EMPTY_SERVICE_HEALTH_STATS
}

/**
 * Story 6.2 AC 15: wires `monitoredServiceHealth` to real per-project service_endpoints.status
 * counts, mirroring getBatchedProjectCredentialStats's one-query-grouped-by-project_id shape.
 */
export async function getBatchedProjectServiceHealthStats(
  tx: Tx,
  projectIds: string[]
): Promise<Map<string, ProjectServiceHealthStats>> {
  if (projectIds.length === 0) return new Map()

  const rows = await tx
    .select({
      projectId: serviceEndpoints.projectId,
      healthy: sql<number>`count(*) filter (where ${serviceEndpoints.status} = 'healthy')::int`,
      degraded: sql<number>`count(*) filter (where ${serviceEndpoints.status} = 'degraded')::int`,
      down: sql<number>`count(*) filter (where ${serviceEndpoints.status} = 'down')::int`,
    })
    .from(serviceEndpoints)
    .where(inArray(serviceEndpoints.projectId, projectIds))
    .groupBy(serviceEndpoints.projectId)

  return new Map(
    rows.map(
      (row) =>
        [
          row.projectId,
          { healthy: Number(row.healthy), degraded: Number(row.degraded), down: Number(row.down) },
        ] as const
    )
  )
}

function buildProjectDashboard(
  stats: ProjectCredentialStats,
  unresolvedAlertCount: number,
  monitoredServiceHealth: ProjectServiceHealthStats,
  upcomingRotations: ProjectDashboard['upcomingRotations'],
  recentAccessEvents: ProjectDashboard['recentAccessEvents']
): ProjectDashboard {
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
    recentAccessEvents,
    // ADR-3.4-01: security_alerts has no project_id — project dashboard mirrors the
    // org-wide unresolved count until Epic 6 project-scoped monitoring alerts exist.
    unresolvedAlertCount,
    isEmpty,
    suggestedActions: suggestedActionsFor(credentialTotal, serviceTotal, isEmpty),
  }
}

// AC-S1/S2/S3: a fully-empty project keeps the original 3-action list; a partially-covered
// project (exactly one category populated) gets a single targeted suggestion for the missing
// category; a fully-covered project gets none.
function suggestedActionsFor(
  credentialTotal: number,
  serviceTotal: number,
  isEmpty: boolean
): ProjectDashboard['suggestedActions'] {
  if (isEmpty) return ['add_credential', 'add_service', 'import_credentials']
  if (credentialTotal > 0 && serviceTotal === 0) return ['add_service']
  if (credentialTotal === 0 && serviceTotal > 0) return ['add_credential', 'import_credentials']
  return []
}

// Story 5.2 AC-15: fixed 30-day default horizon — the dashboard is a fixed summary view, not a
// filterable list (no query-param horizon here, unlike GET .../rotations/upcoming).
const PROJECT_DASHBOARD_ROTATION_HORIZON_DAYS = 30

// Code-review fix: match the org dashboard's 20-item cap on projectsWithOverdueRotations.items
// (below) — this list was previously returned unbounded, an inconsistent and unnecessary
// payload-size/pagination gap versus the adjacent org-dashboard slice.
const PROJECT_DASHBOARD_UPCOMING_ROTATIONS_LIMIT = 20

// AC-A1: the "Recent activity" section's fixed cap (mirrors the 10 hardcoded in the story's
// getRecentAccessEventsForProject(tx, projectId, limit=10) example call signature).
const PROJECT_DASHBOARD_RECENT_ACCESS_EVENTS_LIMIT = 10

export async function getProjectDashboardData(
  tx: Tx,
  projectId: string
): Promise<ProjectDashboard> {
  const [
    statsByProject,
    unresolvedAlertCount,
    serviceHealthByProject,
    upcomingRotationResults,
    recentAccessEvents,
  ] = await Promise.all([
    getBatchedProjectCredentialStats(tx, [projectId]),
    getUnresolvedSecurityAlertCount(tx),
    getBatchedProjectServiceHealthStats(tx, [projectId]),
    computeUpcomingRotations(tx, {
      projectId,
      horizonDays: PROJECT_DASHBOARD_ROTATION_HORIZON_DAYS,
    }),
    getRecentAccessEventsForProject(tx, projectId, PROJECT_DASHBOARD_RECENT_ACCESS_EVENTS_LIMIT),
  ])
  return buildProjectDashboard(
    lookupProjectStats(statsByProject, projectId),
    unresolvedAlertCount,
    lookupServiceHealthStats(serviceHealthByProject, projectId),
    upcomingRotationResults
      .slice(0, PROJECT_DASHBOARD_UPCOMING_ROTATIONS_LIMIT)
      .map(serializeUpcomingRotation),
    recentAccessEvents
  )
}

type MembershipJoin = ReturnType<typeof and>

async function getScopedCredentialCounts(
  tx: Tx,
  scopeToMembership: boolean,
  membershipJoin: MembershipJoin
): Promise<{ totalCredentials: number; expiringCount: number }> {
  const totalQuery = tx.select({ totalCredentials: sql<number>`count(*)::int` }).from(credentials)
  const [{ totalCredentials } = { totalCredentials: 0 }] = await (scopeToMembership
    ? totalQuery.innerJoin(projectMemberships, membershipJoin)
    : totalQuery)

  const expiringCountQuery = tx
    .select({ expiringCount: sql<number>`count(*)::int` })
    .from(credentials)
  const [{ expiringCount } = { expiringCount: 0 }] = await (scopeToMembership
    ? expiringCountQuery.innerJoin(projectMemberships, membershipJoin).where(EXPIRING_FILTER)
    : expiringCountQuery.where(EXPIRING_FILTER))

  return { totalCredentials: Number(totalCredentials), expiringCount: Number(expiringCount) }
}

async function getExpiringCredentialRows(
  tx: Tx,
  scopeToMembership: boolean,
  membershipJoin: MembershipJoin,
  expiringCount: number
) {
  if (expiringCount === 0) return []

  const expiringSelect = tx
    .select({
      id: credentials.id,
      name: credentials.name,
      projectId: credentials.projectId,
      projectName: projects.name,
      expiresAt: credentials.expiresAt,
    })
    .from(credentials)
    .innerJoin(projects, eq(projects.id, credentials.projectId))

  return scopeToMembership
    ? expiringSelect
        .innerJoin(projectMemberships, membershipJoin)
        .where(and(EXPIRING_FILTER, isNotNull(credentials.expiresAt)))
        .orderBy(asc(credentials.expiresAt))
        .limit(20)
    : expiringSelect
        .where(and(EXPIRING_FILTER, isNotNull(credentials.expiresAt)))
        .orderBy(asc(credentials.expiresAt))
        .limit(20)
}

/**
 * Story 4.5 AC-V6: post-filter overdue rotations to visible credentials (computeUpcomingRotations
 * has no multi-project filter; do not change its signature). Returns `null` when the caller is
 * unscoped (org owner/admin), meaning "everything is visible".
 */
async function getVisibleCredentialIds(
  tx: Tx,
  scopeToMembership: boolean,
  opts?: { userId: string }
): Promise<Set<string> | null> {
  if (!scopeToMembership || !opts) return null
  const visibleRows = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .innerJoin(
      projectMemberships,
      and(
        eq(projectMemberships.projectId, credentials.projectId),
        eq(projectMemberships.userId, opts.userId)
      )
    )
  return new Set(visibleRows.map((r) => r.id))
}

export async function getOrgDashboardData(
  tx: Tx,
  opts?: { userId: string; orgRole: OrgRole }
): Promise<OrgDashboard> {
  const scopeToMembership = opts !== undefined && roleRank(opts.orgRole) < roleRank('admin')
  const membershipJoin = and(
    eq(projectMemberships.projectId, credentials.projectId),
    eq(projectMemberships.userId, opts?.userId ?? '')
  )

  const { totalCredentials, expiringCount } = await getScopedCredentialCounts(
    tx,
    scopeToMembership,
    membershipJoin
  )
  const expiringRows = await getExpiringCredentialRows(
    tx,
    scopeToMembership,
    membershipJoin,
    expiringCount
  )

  // Story 4.5 AC-V6: unresolvedAlertCount is intentionally org-wide for every caller —
  // security_alerts has no project_id column (ADR-3.4-01/02), so it cannot be membership-scoped.
  const unresolvedAlertCount = await getUnresolvedSecurityAlertCount(tx)

  // Story 5.2 AC-15: org-wide (no projectId), horizonDays: 0. Do NOT rely on the horizonDays:0
  // inclusion boundary alone to mean "overdue-only" — AC-14's inclusion rule is
  // `nextDueAt <= now + horizonDays` (inclusive) while its status label is 'overdue' only when
  // `nextDueAt < now` (strict), so a credential landing exactly at "now" would otherwise slip
  // into this bucket unlabeled as overdue. The explicit filter below is the actual gate.
  const upcomingRotationResults = await computeUpcomingRotations(tx, { horizonDays: 0 })

  const visibleCredentialIds = await getVisibleCredentialIds(tx, scopeToMembership, opts)
  const overdueRotations = upcomingRotationResults
    .filter((r) => (visibleCredentialIds ? visibleCredentialIds.has(r.credentialId) : true))
    .filter((r) => r.status === 'overdue')

  return {
    totalCredentials,
    expiringWithin30Days: {
      count: expiringCount,
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
