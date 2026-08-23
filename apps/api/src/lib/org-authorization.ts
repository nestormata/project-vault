import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type {
  OrgAuthorizationCheckContext,
  OrgAuthorizationOutcome,
} from '@project-vault/extension-api'
import { resolveActiveOrgRole } from '../plugins/authenticate.js'
import type { OrgRole } from '../plugins/require-org-role.js'
import { roleRank } from './secure-route.js'
import { operationalLog } from './logger.js'
import { getRequestContext } from './request-context.js'

const RECOGNIZED_MINIMUM_ROLES = new Set<string>(['owner', 'admin', 'member', 'viewer'])

function isRecognizedOrgRole(value: string): value is OrgRole {
  return RECOGNIZED_MINIMUM_ROLES.has(value)
}

// ---------------------------------------------------------------------------------------------
// AC8 (Task 5) — per-extension rate-limiting, mirroring capability-gate.ts's
// `tryAcquireSlot`/`accountingKeyFor`-style in-flight accounting. This is a DISTINCT accounting
// map and budget from capability-gate.ts's own `inFlightCounts` — checkMembership must never
// borrow or share capability-gate's budget, per the story's explicit instruction. Bounded state:
// an entry exists only while its key has a non-zero in-flight count and is deleted at zero.
// ---------------------------------------------------------------------------------------------

/** AC8: per-extension in-flight cap for `checkOrgAuthorization()`. PV-internal; not part of the
 * published `extension-api` contract. */
export const ORG_AUTHORIZATION_MAX_IN_FLIGHT_PER_EXTENSION = 20

const orgAuthorizationInFlightCounts = new Map<string, number>()

function orgAuthorizationAccountingKeyFor(extensionName: string): string {
  return `org-authorization:${extensionName}`
}

function tryAcquireOrgAuthorizationSlot(key: string, max: number): boolean {
  const current = orgAuthorizationInFlightCounts.get(key) ?? 0
  if (current >= max) return false
  orgAuthorizationInFlightCounts.set(key, current + 1)
  return true
}

function releaseOrgAuthorizationSlot(key: string): void {
  const current = orgAuthorizationInFlightCounts.get(key) ?? 0
  if (current <= 1) orgAuthorizationInFlightCounts.delete(key)
  else orgAuthorizationInFlightCounts.set(key, current - 1)
}

/** Test-only introspection — never called from production code. */
export function __getOrgAuthorizationInFlightCountForTests(extensionName: string): number {
  return orgAuthorizationInFlightCounts.get(orgAuthorizationAccountingKeyFor(extensionName)) ?? 0
}

/** Test-only reset — never called from production code. */
export function __resetOrgAuthorizationRateLimitForTests(): void {
  orgAuthorizationInFlightCounts.clear()
}

const RATE_LIMITED_REASON_CODE = 'rate-limited'

type AuditLogger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>

/**
 * AC8(b) — a new structured audit-log entry recorded on EVERY `checkOrgAuthorization()` call
 * (granted, denied, or errored — including a rate-limited call), mirroring
 * `capability-gate-audit.ts`'s pattern of a dedicated, allowlisted-fields recording function.
 * Deliberately logs only `organizationId`/`viewerIdentityId`/`minimumRole`/`outcome`/
 * `extensionName` — never `reasonCode` or any other internal error detail (AC3/AC4's existing
 * non-leak discipline; a distinct `reasonCode` per denial branch would itself be a
 * membership-existence oracle, the exact class of leak fixed elsewhere in this file).
 *
 * Never throws — a logging failure must never affect `checkOrgAuthorization()`'s own return
 * value.
 */
function recordOrgAuthorizationCheckAudit(
  logger: AuditLogger,
  fields: {
    extensionName: string
    organizationId: string
    viewerIdentityId: string
    minimumRole: string
    outcome: OrgAuthorizationOutcome['outcome']
  }
): void {
  try {
    operationalLog(
      logger,
      'info',
      OperationalEvent.ORG_AUTHORIZATION_CHECK_RECORDED,
      'orgAuthorization.checkMembership() call recorded',
      fields
    )
  } catch {
    // Never let an audit-logging failure surface to the caller.
  }
}

/** AC8 — the host-only context threaded in by `loader.ts`'s `buildHostServices()`. Never part of
 * the extension-facing `OrgAuthorizationCheckContext`/`checkMembership()` public signature. */
export type CheckOrgAuthorizationHostContext = {
  /** Identifies the loaded extension's own accounting bucket — never shared across extensions,
   * and never the capability-gate's own budget. */
  extensionName: string
  logger?: AuditLogger
  /** Test-only override of the per-extension in-flight cap, mirroring
   * `checkCapability()`'s `maxInFlightPerSurface` seam. */
  maxInFlight?: number
}

const DEFAULT_HOST_CONTEXT: CheckOrgAuthorizationHostContext = {
  extensionName: 'unknown-extension',
}

// AC4: reasonCode on the 'error' outcome must never leak raw internal detail (e.g. driver/DB
// error text, or withOrg()'s own "invalid orgId, received: ..." message) to extension code —
// only a fixed, generic diagnostic string. Code review finding (2026-08-22): the original
// implementation truncated `error.message` to this length but still echoed its *content*
// verbatim, contradicting this comment's own stated intent.
const INTERNAL_ERROR_REASON_CODE = 'resolution-failed'

// Story 23.11 AC4: no ambient per-request context bound (e.g. this is called from code that
// isn't running inside a request lifecycle at all — see request-context.ts's Dev Notes on
// machine-authenticated routes, which never populate request.authContext and therefore never
// bind this context) fails closed with this fixed reasonCode. Never thrown, never falls back to
// any other org id.
const NO_REQUEST_CONTEXT_REASON_CODE = 'no-request-context'

/**
 * Story 23.9 — `HostServices.orgAuthorization.checkMembership()`'s real implementation, bound to
 * the loading extension by `loader.ts`'s `buildHostServices()`. Reuses
 * `authenticate.ts`'s `resolveActiveOrgRole()` for membership lookup (Task 1) and
 * `secure-route.ts`'s `roleRank()` for the "at least this role" comparison (AC2) — no new
 * authorization logic is written here.
 *
 * Never throws (AC4) and never caches/memoizes across calls (AC5) — every call re-runs Task 1's
 * resolution fresh.
 *
 * Story 23.11 AC3/AC4: the org this check runs against is always the ambient per-request context
 * (`request-context.ts`'s `getRequestContext()`) — `context` (the extension-facing call shape)
 * no longer carries an `organizationId` field at all, so there is structurally no way for a
 * caller to supply an arbitrary org. The ambient-context check lives HERE, inside
 * `checkOrgAuthorization()`'s existing resolution path (not as an early return in
 * `checkOrgAuthorization()` itself, before the audit-logging call), so a `no-request-context`
 * outcome still flows through the same `recordOrgAuthorizationCheckAudit()` call every other
 * outcome does (AC4 pre-mortem finding: a bypassed audit path here would let a request-lifecycle
 * refactor silently break every `checkMembership` call for months with no operational signal).
 */
async function resolveOrgAuthorizationOutcome(
  context: OrgAuthorizationCheckContext
): Promise<OrgAuthorizationOutcome> {
  // AC7: an out-of-enum minimumRole must be rejected before it ever reaches roleRank()'s
  // exhaustive switch (which has no default case and would otherwise mis-compare or throw).
  if (!isRecognizedOrgRole(context.minimumRole)) {
    return { outcome: 'error', reasonCode: 'invalid-minimum-role' }
  }

  const ambientContext = getRequestContext()
  if (!ambientContext) {
    return { outcome: 'error', reasonCode: NO_REQUEST_CONTEXT_REASON_CODE }
  }

  let role: OrgRole | null
  try {
    role = await resolveActiveOrgRole(context.viewerIdentityId, ambientContext.orgId)
  } catch {
    // AC4: a genuine internal failure (e.g. a DB error during resolution) maps to 'error', never
    // an escaping exception. reasonCode is a fixed, generic diagnostic string — never the raw
    // caught error's message (that would leak internal detail, e.g. withOrg()'s own
    // "invalid orgId, received: ..." text, to extension code across a trust boundary).
    return { outcome: 'error', reasonCode: INTERNAL_ERROR_REASON_CODE }
  }

  // AC3: no row at all, or a row that exists but is not status: 'active', both surface from
  // resolveActiveOrgRole() as the same plain `null` — an expected "not currently a qualifying
  // member" case, not a system fault.
  if (!role) {
    return { outcome: 'denied', reasonCode: 'not-a-member' }
  }

  if (roleRank(role) < roleRank(context.minimumRole)) {
    // Code review finding (2026-08-22): deliberately reuses AC3's 'not-a-member' reasonCode
    // rather than a distinct 'insufficient-role' string. reasonCode is documented as
    // diagnostic-only, not a stable contract (see Dev Notes), and no AC pins a distinct value for
    // this branch — but a distinct value here would let a caller distinguish "no active
    // membership at all" from "active member, role too low" purely by reading reasonCode, which
    // is a membership-existence oracle for an (organizationId, viewerIdentityId) pair the caller
    // may have no legitimate relationship to. Both denial paths are collapsed to the same
    // reasonCode so only the boolean authorized/denied signal is observable, never which reason.
    return { outcome: 'denied', reasonCode: 'not-a-member' }
  }

  return { outcome: 'authorized' }
}

// Story 23.11: the audit log's `organizationId` field is sourced from the ambient context, not
// the (now nonexistent) `context.organizationId`. When no ambient context is bound at all (the
// AC4 fail-closed path), this fixed placeholder is logged instead of a real org id — there is no
// caller-supplied value to fall back to, and falling back to one would defeat the entire point of
// this story.
const UNBOUND_CONTEXT_AUDIT_ORG_ID = 'unbound-context'

function auditOrganizationId(): string {
  return getRequestContext()?.orgId ?? UNBOUND_CONTEXT_AUDIT_ORG_ID
}

/**
 * Story 23.9 AC8 (Task 5) — wraps `resolveOrgAuthorizationOutcome()` with (a) per-extension
 * rate-limiting via a distinct in-flight accounting budget from capability-gate.ts's own, and
 * (b) a structured audit-log entry recorded on every call regardless of outcome. `hostContext` is
 * threaded in by `loader.ts`'s `buildHostServices()` closure — it is never part of the
 * extension-facing `checkMembership(context)` call signature extensions themselves invoke.
 */
export async function checkOrgAuthorization(
  context: OrgAuthorizationCheckContext,
  hostContext: CheckOrgAuthorizationHostContext = DEFAULT_HOST_CONTEXT
): Promise<OrgAuthorizationOutcome> {
  const logger = hostContext.logger ?? {}
  const accountingKey = orgAuthorizationAccountingKeyFor(hostContext.extensionName)
  const maxInFlight = hostContext.maxInFlight ?? ORG_AUTHORIZATION_MAX_IN_FLIGHT_PER_EXTENSION

  if (!tryAcquireOrgAuthorizationSlot(accountingKey, maxInFlight)) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.ORG_AUTHORIZATION_RATE_LIMITED,
      'checkMembership() call denied without invoking resolution — extension at its in-flight cap',
      { extensionName: hostContext.extensionName }
    )
    const outcome: OrgAuthorizationOutcome = {
      outcome: 'error',
      reasonCode: RATE_LIMITED_REASON_CODE,
    }
    recordOrgAuthorizationCheckAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId: auditOrganizationId(),
      viewerIdentityId: context.viewerIdentityId,
      minimumRole: context.minimumRole,
      outcome: outcome.outcome,
    })
    return outcome
  }

  try {
    const outcome = await resolveOrgAuthorizationOutcome(context)
    recordOrgAuthorizationCheckAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId: auditOrganizationId(),
      viewerIdentityId: context.viewerIdentityId,
      minimumRole: context.minimumRole,
      outcome: outcome.outcome,
    })
    return outcome
  } finally {
    releaseOrgAuthorizationSlot(accountingKey)
  }
}
