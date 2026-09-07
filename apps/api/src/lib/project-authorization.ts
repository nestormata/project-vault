import type { FastifyBaseLogger } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { projectMemberships, projects } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type {
  ProjectAuthorizationCheckContext,
  ProjectAuthorizationOutcome,
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

function isOrgAdminOrOwner(orgRole: OrgRole): boolean {
  return orgRole === 'owner' || orgRole === 'admin'
}

// ---------------------------------------------------------------------------------------------
// AC5 — per-extension rate-limiting, a THIRD, fully independent in-flight accounting map/budget
// from both org-authorization.ts's own (orgAuthorizationInFlightCounts) and capability-gate.ts's
// own (inFlightCounts) — never shared, never borrowed. Bounded state: an entry exists only while
// its key has a non-zero in-flight count and is deleted at zero.
// ---------------------------------------------------------------------------------------------

/** AC5: per-extension in-flight cap for `checkProjectAuthorization()`. PV-internal; not part of
 * the published `extension-api` contract. */
export const PROJECT_AUTHORIZATION_MAX_IN_FLIGHT_PER_EXTENSION = 20

const projectAuthorizationInFlightCounts = new Map<string, number>()

function projectAuthorizationAccountingKeyFor(extensionName: string): string {
  return `project-authorization:${extensionName}`
}

function tryAcquireProjectAuthorizationSlot(key: string, max: number): boolean {
  const current = projectAuthorizationInFlightCounts.get(key) ?? 0
  if (current >= max) return false
  projectAuthorizationInFlightCounts.set(key, current + 1)
  return true
}

function releaseProjectAuthorizationSlot(key: string): void {
  const current = projectAuthorizationInFlightCounts.get(key) ?? 0
  if (current <= 1) projectAuthorizationInFlightCounts.delete(key)
  else projectAuthorizationInFlightCounts.set(key, current - 1)
}

/** Test-only introspection — never called from production code. */
export function __getProjectAuthorizationInFlightCountForTests(extensionName: string): number {
  return (
    projectAuthorizationInFlightCounts.get(projectAuthorizationAccountingKeyFor(extensionName)) ?? 0
  )
}

/** Test-only reset — never called from production code. */
export function __resetProjectAuthorizationRateLimitForTests(): void {
  projectAuthorizationInFlightCounts.clear()
}

const RATE_LIMITED_REASON_CODE = 'rate-limited'

type AuditLogger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>

/**
 * AC6 — a new structured audit-log entry recorded on EVERY `checkProjectAuthorization()` call
 * (granted, denied, or errored — including a rate-limited call), mirroring
 * `org-authorization.ts`'s `recordOrgAuthorizationCheckAudit()` pattern. Deliberately logs only
 * `organizationId`/`projectId`/`viewerIdentityId`/`minimumRole`/`outcome`/`extensionName` —
 * never `reasonCode` (a distinct reasonCode per denial branch would itself be a
 * membership/tenancy-existence oracle, exactly the class of leak AC3/AC6 close).
 *
 * Never throws — a logging failure must never affect `checkProjectAuthorization()`'s own return
 * value.
 */
function recordProjectAuthorizationCheckAudit(
  logger: AuditLogger,
  fields: {
    extensionName: string
    organizationId: string
    projectId: string
    viewerIdentityId: string
    minimumRole: string
    outcome: ProjectAuthorizationOutcome['outcome']
  }
): void {
  try {
    operationalLog(
      logger,
      'info',
      OperationalEvent.PROJECT_AUTHORIZATION_CHECK_RECORDED,
      'projectAuthorization.checkProjectMembership() call recorded',
      fields
    )
  } catch {
    // Never let an audit-logging failure surface to the caller.
  }
}

/** AC5/AC6 — the host-only context threaded in by `loader.ts`'s `buildHostServices()`. Never
 * part of the extension-facing `ProjectAuthorizationCheckContext`/`checkProjectMembership()`
 * public signature. */
export type CheckProjectAuthorizationHostContext = {
  /** Identifies the loaded extension's own accounting bucket — never shared across extensions,
   * and never org-authorization's or capability-gate's own budget. */
  extensionName: string
  logger?: AuditLogger
  /** Test-only override of the per-extension in-flight cap, mirroring
   * `checkOrgAuthorization()`'s `maxInFlight` seam. */
  maxInFlight?: number
}

const DEFAULT_HOST_CONTEXT: CheckProjectAuthorizationHostContext = {
  extensionName: 'unknown-extension',
}

// AC3.2/AC3.3/AC2.3 — every denial reason this hook can distinguish internally ("project not
// found in this org," "project found but no explicit membership row and no org-role fallback,"
// "membership row present but role too low") collapses to this SAME reasonCode, deliberately, to
// avoid a membership/tenancy-existence oracle — mirroring org-authorization.ts's own
// 'not-a-member' collapsing.
const NOT_A_PROJECT_MEMBER_REASON_CODE = 'not-a-project-member'

// AC3.3/AC2's genuine internal-failure path (DB error, malformed projectId UUID cast error) —
// never the raw caught error's message (that would leak internal detail across the trust
// boundary), always this fixed, generic diagnostic string.
const INTERNAL_ERROR_REASON_CODE = 'resolution-failed'

// Story 23.11 AC4-equivalent: no ambient per-request context bound (e.g. this is called from a
// machine-authenticated route via verifyMachineRequest(), which never populates
// request.authContext/binds RequestContext) fails closed with this fixed reasonCode. Never
// thrown, never falls back to any other org id. Machine-authenticated call paths correctly and
// expectedly hit this branch — it is not later mistaken for a bug.
const NO_REQUEST_CONTEXT_REASON_CODE = 'no-request-context'

// A malformed call from a buggy/untrusted extension (null/undefined `context`, or a `context`
// missing/misshaping one of its required fields) — never type-checked at runtime, since
// `checkProjectMembership()` is invoked by third-party extension code. Fails closed with this
// fixed reasonCode rather than letting a property access throw and violate this hook's "never
// throws" contract.
const INVALID_CONTEXT_REASON_CODE = 'invalid-context'

function isValidProjectAuthorizationCheckContext(
  context: unknown
): context is ProjectAuthorizationCheckContext {
  if (typeof context !== 'object' || context === null) return false
  const candidate = context as Record<string, unknown>
  return (
    typeof candidate.viewerIdentityId === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.minimumRole === 'string'
  )
}

/** Best-effort extraction of the three `ProjectAuthorizationCheckContext` fields for audit
 * logging of a call whose `context` failed validation — never throws, and never assumes any
 * field is actually present. Field names are fixed literals (never a caller-supplied string), so
 * this reads each named field explicitly rather than by dynamic key. */
function safeAuditFields(context: unknown): {
  projectId: string
  viewerIdentityId: string
  minimumRole: string
} {
  if (typeof context !== 'object' || context === null) {
    return { projectId: '', viewerIdentityId: '', minimumRole: '' }
  }
  const candidate = context as Record<string, unknown>
  return {
    projectId: typeof candidate.projectId === 'string' ? candidate.projectId : '',
    viewerIdentityId:
      typeof candidate.viewerIdentityId === 'string' ? candidate.viewerIdentityId : '',
    minimumRole: typeof candidate.minimumRole === 'string' ? candidate.minimumRole : '',
  }
}

/**
 * AC3.2 — the single query this hook's cross-tenant-enumeration defense depends on: a
 * `projects LEFT JOIN project_memberships` that returns in the same shape (and takes the same
 * time) regardless of which denial reason ultimately applies, closing a timing side-channel a
 * two-sequential-query implementation would otherwise have (see this story's Dev Notes
 * Architecture Decision 2). Returns `undefined` when `projectId` does not belong to `orgId` at
 * all (or does not exist); returns `{ role: null }` when the project belongs to `orgId` but
 * `userId` holds no explicit `project_memberships` row for it; returns `{ role: <string> }` when
 * an explicit row exists.
 */
async function queryProjectInOrgAndMembershipRole(
  orgId: string,
  projectId: string,
  userId: string
): Promise<{ role: string | null } | undefined> {
  const rows = await withOrg(orgId, (tx: Tx) =>
    tx
      .select({ role: projectMemberships.role })
      .from(projects)
      .leftJoin(
        projectMemberships,
        and(eq(projectMemberships.projectId, projects.id), eq(projectMemberships.userId, userId))
      )
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .limit(1)
  )
  const [row] = rows
  return row ? { role: row.role ?? null } : undefined
}

/**
 * AC2.2 — resolves the effective project role for `viewerIdentityId`, adapting
 * `effectiveProjectRole()`'s bypass + fallback semantics (`project-access.ts`) to a
 * `viewerIdentityId` that — unlike `effectiveProjectRole()`'s `secureCtx.auth.orgRole`, which is
 * guaranteed non-null by the caller already having authenticated into an active org membership —
 * is an arbitrary, extension-supplied identity whose org role can genuinely be `null` (no active
 * `orgMemberships` row, or a row present but not `status = 'active'`, e.g. suspended/deactivated
 * without a full org removal — `removeUserFromOrgMemberships()` only deletes `project_memberships`
 * rows on full removal, not on suspension). A `null` org role therefore denies unconditionally,
 * REGARDLESS of any explicit `project_memberships` row: a caller who is not currently an active
 * org member must never be authorized via a stale project-membership row alone. Org owner/admin
 * gets an unconditional bypass using their own org role (even when an explicit, lower
 * `project_memberships` row exists — the bypass never consults that row at all); an active
 * member/viewer falls through to the explicit row already fetched by AC3's joined query,
 * defaulting to their own org role when no row exists. Returns `undefined` when there is no
 * qualifying role at all. Only ever called AFTER AC3's project-in-org check has already passed —
 * see `resolveProjectAuthorizationOutcome()`'s ordering-invariant doc comment.
 */
async function resolveEffectiveProjectRole(
  orgId: string,
  viewerIdentityId: string,
  membershipRole: string | null
): Promise<{ role: OrgRole | undefined } | { error: true }> {
  let orgRole: OrgRole | null
  try {
    orgRole = await resolveActiveOrgRole(viewerIdentityId, orgId)
  } catch {
    return { error: true }
  }

  if (orgRole === null) {
    // Not a currently-active org member at all — never fall back to a possibly-stale
    // `project_memberships` row for this identity.
    return { role: undefined }
  }

  const validMembershipRole =
    membershipRole && isRecognizedOrgRole(membershipRole) ? membershipRole : undefined

  const role: OrgRole | undefined = isOrgAdminOrOwner(orgRole)
    ? orgRole
    : (validMembershipRole ?? orgRole)

  return { role }
}

/**
 * Story 37.1 — `HostServices.projectAuthorization.checkProjectMembership()`'s real
 * implementation, bound to the loading extension by `loader.ts`'s `buildHostServices()`.
 *
 * **CRITICAL ORDERING INVARIANT** (see this story's Dev Notes Architecture Decision 1): AC3's
 * project-in-ambient-org validation (`queryProjectInOrgAndMembershipRole()` above) MUST run
 * first, unconditionally, before ANY role resolution — including before the org-owner/admin
 * bypass `effectiveProjectRole()` reuses (AC2.2). That bypass returns the caller's org role with
 * NO project-existence or project-org-membership check of its own — calling it before AC3's
 * validation would let an org owner/admin caller pass an arbitrary or cross-org `projectId` and
 * unconditionally get `authorized`, reopening the exact cross-tenant enumeration hole AC3 exists
 * to close, specifically for the highest-privilege callers. `resolveActiveOrgRole()` (the org-role
 * half of the bypass check) is therefore never called until AC3.2's query has already confirmed
 * the project belongs to the ambient org.
 *
 * Never throws (AC3.3/AC4) and never caches/memoizes across calls (mirrors
 * `resolveOrgAuthorizationOutcome()`'s AC5 discipline) — every call re-runs resolution fresh.
 */
async function resolveProjectAuthorizationOutcome(
  context: ProjectAuthorizationCheckContext
): Promise<ProjectAuthorizationOutcome> {
  if (!isValidProjectAuthorizationCheckContext(context)) {
    return { outcome: 'error', reasonCode: INVALID_CONTEXT_REASON_CODE }
  }

  if (!isRecognizedOrgRole(context.minimumRole)) {
    return { outcome: 'error', reasonCode: 'invalid-minimum-role' }
  }

  const ambientContext = getRequestContext()
  if (!ambientContext) {
    return { outcome: 'error', reasonCode: NO_REQUEST_CONTEXT_REASON_CODE }
  }

  let projectInOrg: { role: string | null } | undefined
  try {
    projectInOrg = await queryProjectInOrgAndMembershipRole(
      ambientContext.orgId,
      context.projectId,
      context.viewerIdentityId
    )
  } catch {
    // AC3.3: a genuine internal failure (DB error) OR a malformed projectId (Postgres UUID cast
    // error) both map to 'error', never an escaping exception and never 'denied' — a malformed
    // identifier was never conclusively evaluated against real data.
    return { outcome: 'error', reasonCode: INTERNAL_ERROR_REASON_CODE }
  }

  // AC3.2: no row at all means projectId does not belong to the ambient org (or does not exist).
  // This is the critical cross-tenant-enumeration-closing branch — it returns BEFORE
  // resolveActiveOrgRole()/the org-owner/admin bypass is ever consulted, so an org owner/admin
  // caller gets no special treatment here either.
  if (!projectInOrg) {
    return { outcome: 'denied', reasonCode: NOT_A_PROJECT_MEMBER_REASON_CODE }
  }

  // AC2.2: only now — after AC3's project-in-org check has already passed — is the effective
  // project role resolved.
  const effective = await resolveEffectiveProjectRole(
    ambientContext.orgId,
    context.viewerIdentityId,
    projectInOrg.role
  )
  if ('error' in effective) {
    return { outcome: 'error', reasonCode: INTERNAL_ERROR_REASON_CODE }
  }

  if (!effective.role) {
    return { outcome: 'denied', reasonCode: NOT_A_PROJECT_MEMBER_REASON_CODE }
  }

  if (roleRank(effective.role) < roleRank(context.minimumRole)) {
    // AC2.3: "no membership row" and "row/org-role exists but too low" collapse to the identical
    // reasonCode — deliberately, to avoid a membership-existence oracle via reasonCode.
    return { outcome: 'denied', reasonCode: NOT_A_PROJECT_MEMBER_REASON_CODE }
  }

  return { outcome: 'authorized' }
}

// AC6: the audit log's organizationId field is sourced from the ambient context, not a
// caller-supplied value. When no ambient context is bound at all (the fail-closed path), this
// fixed placeholder is logged instead of a real org id.
const UNBOUND_CONTEXT_AUDIT_ORG_ID = 'unbound-context'

function auditOrganizationId(): string {
  return getRequestContext()?.orgId ?? UNBOUND_CONTEXT_AUDIT_ORG_ID
}

/**
 * AC5/AC6 (Task 2) — wraps `resolveProjectAuthorizationOutcome()` with (a) per-extension
 * rate-limiting via a distinct in-flight accounting budget from both org-authorization.ts's own
 * and capability-gate.ts's own, and (b) a structured audit-log entry recorded on every call
 * regardless of outcome. `hostContext` is threaded in by `loader.ts`'s `buildHostServices()`
 * closure — it is never part of the extension-facing `checkProjectMembership(context)` call
 * signature extensions themselves invoke.
 */
export async function checkProjectAuthorization(
  context: ProjectAuthorizationCheckContext,
  hostContext: CheckProjectAuthorizationHostContext = DEFAULT_HOST_CONTEXT
): Promise<ProjectAuthorizationOutcome> {
  const logger = hostContext.logger ?? {}
  const accountingKey = projectAuthorizationAccountingKeyFor(hostContext.extensionName)
  const maxInFlight = hostContext.maxInFlight ?? PROJECT_AUTHORIZATION_MAX_IN_FLIGHT_PER_EXTENSION

  if (!tryAcquireProjectAuthorizationSlot(accountingKey, maxInFlight)) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.PROJECT_AUTHORIZATION_RATE_LIMITED,
      'checkProjectMembership() call denied without invoking resolution — extension at its in-flight cap',
      { extensionName: hostContext.extensionName }
    )
    const outcome: ProjectAuthorizationOutcome = {
      outcome: 'error',
      reasonCode: RATE_LIMITED_REASON_CODE,
    }
    recordProjectAuthorizationCheckAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId: auditOrganizationId(),
      ...safeAuditFields(context),
      outcome: outcome.outcome,
    })
    return outcome
  }

  try {
    // Never let an unexpected exception (e.g. a malformed/null `context` from a buggy or
    // untrusted extension — `checkProjectMembership()` is invoked by third-party code that is
    // never type-checked at runtime) escape as a rejected promise: this hook's contract is to
    // never throw, always resolving to one of the three `ProjectAuthorizationOutcome` shapes.
    let outcome: ProjectAuthorizationOutcome
    try {
      outcome = await resolveProjectAuthorizationOutcome(context)
    } catch {
      outcome = { outcome: 'error', reasonCode: INVALID_CONTEXT_REASON_CODE }
    }
    recordProjectAuthorizationCheckAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId: auditOrganizationId(),
      ...safeAuditFields(context),
      outcome: outcome.outcome,
    })
    return outcome
  } finally {
    releaseProjectAuthorizationSlot(accountingKey)
  }
}
