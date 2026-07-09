import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import {
  listPlatformAuditEvents,
  getMaintenanceModeStatus,
  type PlatformAuditEventItem,
  type MaintenanceModeStatus,
  type PlatformAuditFilters,
  type PlatformAuditEventsResponse,
} from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

function readFilters(url: URL): PlatformAuditFilters {
  const filters: PlatformAuditFilters = {}
  const operatorId = url.searchParams.get('operatorId')
  const actionType = url.searchParams.get('actionType')
  const targetOrgId = url.searchParams.get('targetOrgId')
  const targetUserId = url.searchParams.get('targetUserId')
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (operatorId) filters.operatorId = operatorId
  if (actionType) filters.actionType = actionType
  if (targetOrgId) filters.targetOrgId = targetOrgId
  if (targetUserId) filters.targetUserId = targetUserId
  if (from) filters.from = from
  if (to) filters.to = to
  return filters
}

function extractEventsData(result: PromiseSettledResult<PlatformAuditEventsResponse>) {
  if (result.status === 'fulfilled') {
    return {
      events: result.value.items,
      total: result.value.total,
      limit: result.value.limit,
      hasNext: result.value.hasNext,
      eventsErrorMessage: null as string | null,
    }
  }
  const msg =
    result.reason instanceof ApiClientError
      ? (result.reason.message ?? 'Failed to load audit events')
      : 'Failed to load audit events'
  return {
    events: [] as PlatformAuditEventItem[],
    total: 0,
    limit: 20,
    hasNext: false,
    eventsErrorMessage: msg,
  }
}

function extractMaintenanceData(result: PromiseSettledResult<MaintenanceModeStatus>) {
  if (result.status === 'fulfilled') {
    return { maintenanceStatus: result.value, maintenanceStatusError: null as string | null }
  }
  return {
    maintenanceStatus: null as MaintenanceModeStatus | null,
    maintenanceStatusError: 'Maintenance mode status unavailable',
  }
}

export const load: PageServerLoad = async ({ fetch, url, locals }) => {
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }

  const filters = readFilters(url)
  const page = Number(url.searchParams.get('page') ?? '1') || 1

  const [eventsResult, maintenanceResult] = await Promise.allSettled([
    listPlatformAuditEvents(fetch, { ...filters, page, limit: 20 }),
    getMaintenanceModeStatus(fetch),
  ])

  const eventsData = extractEventsData(eventsResult)
  const maintenanceData = extractMaintenanceData(maintenanceResult)

  return {
    allowed: true as const,
    filters,
    page,
    ...eventsData,
    ...maintenanceData,
  }
}
