import type { OrgMembershipCheck, OrgMembershipResult } from '@project-vault/extension-api'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { resolveActiveOrgRole } from '../plugins/authenticate.js'
import { isUuid } from '../middleware/rls.js'
import { operationalLog } from './logger.js'

const UNAVAILABLE_REASON = 'membership_check_failed'
const scheduledTaskScopeUnavailable = 'membership_scope_unavailable'
const scheduledTaskScopeMismatch = 'membership_scope_mismatch'
const scheduledTaskInvalidIdentifier = 'membership_check_invalid_identifier'
const scheduledTaskOrganization = new AsyncLocalStorage<{
  organizationId: string
  active: boolean
}>()
const membershipCheckInFlight = new Map<string, number>()
const MAX_MEMBERSHIP_CHECKS_IN_FLIGHT_PER_EXTENSION = 20

type ScheduledTaskMembershipHostContext = {
  extensionName: string
  logger?: Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>
  maxInFlight?: number
}

export function withScheduledTaskOrganization<T>(
  organizationId: string,
  callback: () => T | Promise<T>
): Promise<T> {
  const scope = { organizationId, active: true }
  return scheduledTaskOrganization.run(scope, async () => {
    try {
      return await callback()
    } finally {
      scope.active = false
    }
  })
}

function recordScheduledTaskMembershipCheck(
  check: OrgMembershipCheck,
  organizationId: string | undefined,
  result: OrgMembershipResult,
  hostContext: ScheduledTaskMembershipHostContext
): void {
  try {
    operationalLog(
      hostContext.logger ?? {},
      'info',
      OperationalEvent.ORG_AUTHORIZATION_CHECK_RECORDED,
      'scheduled-task membership check recorded',
      {
        extensionName: hostContext.extensionName,
        organizationId: organizationId ?? 'unbound-context',
        viewerIdentityId: check.userId,
        minimumRole: 'membership',
        outcome:
          result.status === 'allowed'
            ? 'authorized'
            : result.status === 'denied'
              ? 'denied'
              : 'error',
      }
    )
  } catch {
    // Logging must not change the authorization result.
  }
}

async function resolveScheduledTaskMembership(
  check: OrgMembershipCheck,
  organizationId: string | undefined,
  hostContext: ScheduledTaskMembershipHostContext
): Promise<OrgMembershipResult> {
  const invalidScopeReason = getScheduledTaskMembershipScopeReason(check, organizationId)
  if (invalidScopeReason) return { status: 'unavailable', reason: invalidScopeReason }

  const accountingKey = `scheduled-membership:${hostContext.extensionName}`
  const inFlight = membershipCheckInFlight.get(accountingKey) ?? 0
  const maxInFlight = hostContext.maxInFlight ?? MAX_MEMBERSHIP_CHECKS_IN_FLIGHT_PER_EXTENSION
  if (inFlight >= maxInFlight) {
    recordScheduledTaskMembershipRateLimit(hostContext)
    return { status: 'unavailable', reason: 'membership_check_rate_limited' }
  }

  membershipCheckInFlight.set(accountingKey, inFlight + 1)
  try {
    return await isOrgMember(check)
  } finally {
    const current = membershipCheckInFlight.get(accountingKey) ?? 0
    if (current <= 1) membershipCheckInFlight.delete(accountingKey)
    else membershipCheckInFlight.set(accountingKey, current - 1)
  }
}

function getScheduledTaskMembershipScopeReason(
  check: OrgMembershipCheck,
  organizationId: string | undefined
): string | undefined {
  if (organizationId === undefined || !isUuid(organizationId)) {
    return scheduledTaskScopeUnavailable
  }
  if (!isUuid(check.organizationId) || !isUuid(check.userId)) {
    return scheduledTaskInvalidIdentifier
  }
  if (check.organizationId !== organizationId) {
    return scheduledTaskScopeMismatch
  }
  return undefined
}

function recordScheduledTaskMembershipRateLimit(hostContext: ScheduledTaskMembershipHostContext) {
  try {
    operationalLog(
      hostContext.logger ?? {},
      'warn',
      OperationalEvent.ORG_AUTHORIZATION_RATE_LIMITED,
      'scheduled-task membership check was rate limited',
      { extensionName: hostContext.extensionName }
    )
  } catch {
    // Logging must not change the host's fail-closed result.
  }
}

export async function isOrgMemberForScheduledTask(
  check: OrgMembershipCheck,
  hostContext: ScheduledTaskMembershipHostContext = { extensionName: 'unknown-extension' }
): Promise<OrgMembershipResult> {
  const scope = scheduledTaskOrganization.getStore()
  const organizationId = scope?.active ? scope.organizationId : undefined
  const result = await resolveScheduledTaskMembership(check, organizationId, hostContext)
  recordScheduledTaskMembershipCheck(check, organizationId, result, hostContext)
  return result
}

/**
 * Story 43.30 — the one membership lookup shared by the CLI organization exchange and
 * `HostServices.membership.isOrgMember`. No ambient request. `userId` is `users.id`.
 * A query that finds no active membership is `denied`. Any throw (invalid id, database
 * failure, host failure) is `unavailable` and is never turned into `denied`.
 */
export async function isOrgMember(check: OrgMembershipCheck): Promise<OrgMembershipResult> {
  try {
    const role = await resolveActiveOrgRole(check.userId, check.organizationId)
    return role ? { status: 'allowed' } : { status: 'denied' }
  } catch {
    return { status: 'unavailable', reason: UNAVAILABLE_REASON }
  }
}
