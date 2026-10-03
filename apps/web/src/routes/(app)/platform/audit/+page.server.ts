import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
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

// Story 68.1: the search filters read from the URL never carry pagination (page/limit are
// passed separately), so the page gets a string-only filter shape.
type PlatformAuditSearchFilters = Omit<PlatformAuditFilters, 'page' | 'limit'>

function readFilters(url: URL): PlatformAuditSearchFilters {
  const filters: PlatformAuditSearchFilters = {}
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

type EventsData = {
  events: PlatformAuditEventItem[]
  total: number
  limit: number
  hasNext: boolean
  eventsErrorMessage: string | null
}

function extractEventsData(result: PromiseSettledResult<PlatformAuditEventsResponse>): EventsData {
  if (result.status === 'fulfilled') {
    return {
      events: result.value.items,
      total: result.value.total,
      limit: result.value.limit,
      hasNext: result.value.hasNext,
      eventsErrorMessage: null,
    }
  }
  const msg =
    result.reason instanceof ApiClientError
      ? (result.reason.message ?? 'Failed to load audit events')
      : 'Failed to load audit events'
  return {
    events: [],
    total: 0,
    limit: 20,
    hasNext: false,
    eventsErrorMessage: msg,
  }
}

function extractMaintenanceData(result: PromiseSettledResult<MaintenanceModeStatus>): {
  maintenanceStatus: MaintenanceModeStatus | null
  maintenanceStatusError: string | null
} {
  if (result.status === 'fulfilled') {
    return { maintenanceStatus: result.value, maintenanceStatusError: null }
  }
  return {
    maintenanceStatus: null,
    maintenanceStatusError: 'Maintenance mode status unavailable',
  }
}

const ownLoad = (async ({ fetch, url, locals }) => {
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
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/platform/audit', 'page')

export const actions = injectActions('/(app)/platform/audit')
