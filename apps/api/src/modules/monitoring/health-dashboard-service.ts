import { inArray, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { projects, serviceEndpoints } from '@project-vault/db/schema'
import type { HealthDashboard, HealthDashboardSummary } from '@project-vault/shared'

type ServiceEndpointStatus = 'healthy' | 'degraded' | 'down'

type ServiceRow = {
  id: string
  projectId: string
  name: string
  status: string
  lastCheckedAt: Date | null
}

const EMPTY_SUMMARY: HealthDashboardSummary = { healthy: 0, degraded: 0, down: 0 }

/** Avoids a dynamic-key object write (security/detect-object-injection) for the summary tally. */
function incrementSummary(summary: HealthDashboardSummary, status: ServiceEndpointStatus): void {
  switch (status) {
    case 'healthy':
      summary.healthy += 1
      break
    case 'degraded':
      summary.degraded += 1
      break
    case 'down':
      summary.down += 1
      break
  }
}

/**
 * Story 6.3 (ADR-6.3-02/03/04, realigned): "services" are `service_endpoints` rows, read
 * verbatim — no client-side health-state derivation, no url-null filter (every row is eligible).
 * Queries all non-archived projects for the caller's org (RLS-scoped via the caller's `tx`), then
 * a single batched `service_endpoints` query across every one of those project ids — never one
 * query per project (N+1-avoidance discipline this ADR explicitly calls for).
 */
export async function getHealthDashboardData(tx: Tx): Promise<HealthDashboard> {
  const projectRows = await tx
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(isNull(projects.archivedAt))
    .orderBy(projects.createdAt)

  if (projectRows.length === 0) {
    return { projects: [], summary: { ...EMPTY_SUMMARY } }
  }

  const projectIds = projectRows.map((row) => row.id)
  const serviceRows: ServiceRow[] = await tx
    .select({
      id: serviceEndpoints.id,
      projectId: serviceEndpoints.projectId,
      name: serviceEndpoints.name,
      status: serviceEndpoints.status,
      lastCheckedAt: serviceEndpoints.lastCheckedAt,
    })
    .from(serviceEndpoints)
    .where(inArray(serviceEndpoints.projectId, projectIds))

  const servicesByProject = new Map<string, ServiceRow[]>()
  for (const row of serviceRows) {
    const list = servicesByProject.get(row.projectId)
    if (list) {
      list.push(row)
    } else {
      servicesByProject.set(row.projectId, [row])
    }
  }

  const summary: HealthDashboardSummary = { ...EMPTY_SUMMARY }
  const dashboardProjects: HealthDashboard['projects'] = []

  for (const project of projectRows) {
    const services = servicesByProject.get(project.id)
    if (!services || services.length === 0) continue

    dashboardProjects.push({
      projectId: project.id,
      projectName: project.name,
      services: services.map((service) => {
        const status = service.status as ServiceEndpointStatus
        incrementSummary(summary, status)
        return {
          id: service.id,
          name: service.name,
          status,
          lastCheckedAt: service.lastCheckedAt ? service.lastCheckedAt.toISOString() : null,
        }
      }),
    })
  }

  return { projects: dashboardProjects, summary }
}
