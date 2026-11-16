import type { FastifyBaseLogger } from 'fastify'
import { withOrg } from '@project-vault/db'
import { OperationalEvent } from '@project-vault/shared'
import type {
  EffectiveProjectAccessContext,
  EffectiveProjectAccessOutcome,
} from '@project-vault/extension-api'
import { operationalLog } from './logger.js'
import { getRequestContext } from './request-context.js'
import { isUuid } from '../middleware/rls.js'
import {
  GROUP_GRANT_EVALUATION_NOT_EVALUATED,
  callerVisibleProjectIds,
  listEffectiveProjectAccess,
} from './effective-project-access.js'

type AuditLogger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>

export type EffectiveProjectAccessHostContext = {
  extensionName: string
  logger?: AuditLogger
  maxInFlight?: number
}

const RATE_LIMITED_REASON_CODE = 'rate-limited'
const NO_REQUEST_CONTEXT_REASON_CODE = 'no-request-context'
const INVALID_CONTEXT_REASON_CODE = 'invalid-context'
const INTERNAL_ERROR_REASON_CODE = 'resolution-failed'
const UNBOUND_CONTEXT_AUDIT_ORG_ID = 'unbound-context'
const EFFECTIVE_ACCESS_MAX_IN_FLIGHT_PER_EXTENSION = 20

const effectiveAccessInFlightCounts = new Map<string, number>()

function accountingKeyFor(extensionName: string): string {
  return `project-access-read:${extensionName}`
}

function tryAcquireSlot(key: string, max: number): boolean {
  const current = effectiveAccessInFlightCounts.get(key) ?? 0
  if (current >= max) return false
  effectiveAccessInFlightCounts.set(key, current + 1)
  return true
}

function releaseSlot(key: string): void {
  const current = effectiveAccessInFlightCounts.get(key) ?? 0
  if (current <= 1) effectiveAccessInFlightCounts.delete(key)
  else effectiveAccessInFlightCounts.set(key, current - 1)
}

export function __getEffectiveProjectAccessInFlightCountForTests(extensionName: string): number {
  return effectiveAccessInFlightCounts.get(accountingKeyFor(extensionName)) ?? 0
}

export function __resetEffectiveProjectAccessRateLimitForTests(): void {
  effectiveAccessInFlightCounts.clear()
}

function isValidContext(context: unknown): context is EffectiveProjectAccessContext {
  if (typeof context !== 'object' || context === null) return false
  return typeof (context as { viewerIdentityId?: unknown }).viewerIdentityId === 'string'
}

function viewerIdentityForLog(context: unknown): string {
  if (typeof context !== 'object' || context === null) return ''
  const value = (context as { viewerIdentityId?: unknown }).viewerIdentityId
  return typeof value === 'string' ? value : ''
}

function recordRead(
  logger: AuditLogger,
  fields: {
    extensionName: string
    organizationId: string
    viewerIdentityId: string
    itemCount: number
    outcome: 'ok' | 'error'
  }
): void {
  try {
    operationalLog(
      logger,
      'info',
      OperationalEvent.PROJECT_ACCESS_READ_RECORDED,
      'projectAuthorization.readEffectiveProjectAccess() call recorded',
      fields
    )
  } catch {
    // Logging must not change the outcome.
  }
}

async function resolveEffectiveAccess(
  context: EffectiveProjectAccessContext
): Promise<EffectiveProjectAccessOutcome> {
  if (!isValidContext(context)) {
    return { outcome: 'error', reasonCode: INVALID_CONTEXT_REASON_CODE }
  }

  const ambient = getRequestContext()
  if (!ambient) {
    return { outcome: 'error', reasonCode: NO_REQUEST_CONTEXT_REASON_CODE }
  }

  if (!isUuid(context.viewerIdentityId)) {
    return {
      outcome: 'ok',
      items: [],
      groupGrantEvaluation: GROUP_GRANT_EVALUATION_NOT_EVALUATED,
    }
  }

  try {
    return await withOrg(ambient.orgId, async (tx) => {
      if (!ambient.userId) {
        return {
          outcome: 'ok' as const,
          items: [],
          groupGrantEvaluation: GROUP_GRANT_EVALUATION_NOT_EVALUATED,
        }
      }
      const visibleProjectIds = await callerVisibleProjectIds(tx, {
        orgId: ambient.orgId,
        callerUserId: ambient.userId,
      })
      const listed = await listEffectiveProjectAccess(tx, {
        orgId: ambient.orgId,
        subjectUserId: context.viewerIdentityId,
        visibleProjectIds,
      })
      return { outcome: 'ok' as const, ...listed }
    })
  } catch {
    return { outcome: 'error', reasonCode: INTERNAL_ERROR_REASON_CODE }
  }
}

/**
 * Story 73.6 host adapter. Independent in-flight budget from `checkProjectAuthorization`.
 * Never throws. Organization is ambient request context only.
 */
export async function readEffectiveProjectAccess(
  context: EffectiveProjectAccessContext,
  hostContext: EffectiveProjectAccessHostContext = { extensionName: 'unknown-extension' }
): Promise<EffectiveProjectAccessOutcome> {
  const logger = hostContext.logger ?? {}
  const key = accountingKeyFor(hostContext.extensionName)
  const maxInFlight = hostContext.maxInFlight ?? EFFECTIVE_ACCESS_MAX_IN_FLIGHT_PER_EXTENSION
  const organizationId = getRequestContext()?.orgId ?? UNBOUND_CONTEXT_AUDIT_ORG_ID

  if (!tryAcquireSlot(key, maxInFlight)) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.PROJECT_ACCESS_READ_RATE_LIMITED,
      'readEffectiveProjectAccess() refused — extension at its independent in-flight cap',
      { extensionName: hostContext.extensionName }
    )
    const outcome: EffectiveProjectAccessOutcome = {
      outcome: 'error',
      reasonCode: RATE_LIMITED_REASON_CODE,
    }
    recordRead(logger, {
      extensionName: hostContext.extensionName,
      organizationId,
      viewerIdentityId: viewerIdentityForLog(context),
      itemCount: 0,
      outcome: 'error',
    })
    return outcome
  }

  try {
    let outcome: EffectiveProjectAccessOutcome
    try {
      outcome = await resolveEffectiveAccess(context)
    } catch {
      outcome = { outcome: 'error', reasonCode: INVALID_CONTEXT_REASON_CODE }
    }
    recordRead(logger, {
      extensionName: hostContext.extensionName,
      organizationId,
      viewerIdentityId: viewerIdentityForLog(context),
      itemCount: outcome.outcome === 'ok' ? outcome.items.length : 0,
      outcome: outcome.outcome,
    })
    return outcome
  } finally {
    releaseSlot(key)
  }
}
