import type { FastifyBaseLogger } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { apiKeys, machineUsers } from '@project-vault/db/schema'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import type { CredentialSharingHost, ExtensionManifest } from '@project-vault/extension-api'
import {
  CredentialSharingNoMachineUserError,
  CredentialSharingOrgRateLimitedError,
  CredentialSharingRateLimitedError,
} from '@project-vault/extension-api'
import type { CredentialShareRow } from '../modules/credential-shares/service.js'
import {
  revokeShare as revokeShareService,
  supersedeOutstandingSharesForRotation as supersedeOutstandingSharesForRotationService,
} from '../modules/credential-shares/service.js'
import {
  createExternalCredentialShare,
  findExternalShareByTokenHash,
  revealExternalShare,
} from '../modules/credential-shares/external-service.js'
import { writeMachineAuditEntry } from '../modules/audit/machine-entry.js'
import { isMachineKeyLive } from '../modules/machine-users/key-validity.js'
import { operationalLog } from './logger.js'

/**
 * Story 20.12 AC5 — a per-extension in-flight cap for every `credentialSharing` method. Distinct
 * accounting map and budget from `monitoring-host.ts`'s own and every other hook's own — never
 * shared. Per Elicitation Findings #3 (this story's own ADR), this file owns a structurally
 * identical, sibling wrapper rather than importing/extracting a shared cross-hook abstraction out
 * of `monitoring-host.ts` — matching this codebase's established per-hook-file autonomy.
 */
export const CREDENTIAL_SHARING_HOST_MAX_IN_FLIGHT_PER_EXTENSION = 20

const credentialSharingHostInFlightCounts = new Map<string, number>()

function accountingKeyFor(extensionName: string): string {
  return `credential-sharing-host:${extensionName}`
}

function tryAcquireSlot(key: string, max: number): boolean {
  const current = credentialSharingHostInFlightCounts.get(key) ?? 0
  if (current >= max) return false
  credentialSharingHostInFlightCounts.set(key, current + 1)
  return true
}

function releaseSlot(key: string): void {
  const current = credentialSharingHostInFlightCounts.get(key) ?? 0
  if (current <= 1) credentialSharingHostInFlightCounts.delete(key)
  else credentialSharingHostInFlightCounts.set(key, current - 1)
}

/** Test-only introspection — never called from production code. */
export function __getCredentialSharingHostInFlightCountForTests(extensionName: string): number {
  return credentialSharingHostInFlightCounts.get(accountingKeyFor(extensionName)) ?? 0
}

/** Test-only reset — never called from production code. */
export function __resetCredentialSharingHostRateLimitForTests(): void {
  credentialSharingHostInFlightCounts.clear()
}

// -------------------------------------------------------------------------------------------
// AC5b (Design Decision B, Nestor-confirmed) — per-org token-bucket rate limiter for
// findShareByToken/revealShare, keyed by organizationId (resolved from the token, never by IP —
// IP doesn't exist in-process). A dedicated, in-memory fixed-window structure local to this file
// — deliberately NOT Fastify's route-level `rateLimit` plugin (HTTP-request-scoped, unreachable
// from an in-process call). Matches `external-access-routes.ts`'s existing route limits as the
// starting point: 60/min for findShareByToken, 30/min for revealShare.
// -------------------------------------------------------------------------------------------

export const CREDENTIAL_SHARING_ORG_RATE_LIMIT_WINDOW_MS = 60_000
export const CREDENTIAL_SHARING_FIND_SHARE_BY_TOKEN_ORG_LIMIT = 60
export const CREDENTIAL_SHARING_REVEAL_SHARE_ORG_LIMIT = 30

type OrgRateLimitState = { windowStart: number; count: number }

const orgRateLimitState = new Map<string, OrgRateLimitState>()

function orgRateLimitKeyFor(methodName: string, organizationId: string): string {
  return `${methodName}:${organizationId}`
}

/** Test-only override seam for the window/limit — never used in production wiring. */
function tryAcquireOrgRateLimitSlot(
  key: string,
  max: number,
  windowMs: number,
  now: number
): boolean {
  const state = orgRateLimitState.get(key)
  if (!state || now - state.windowStart >= windowMs) {
    orgRateLimitState.set(key, { windowStart: now, count: 1 })
    return true
  }
  if (state.count >= max) return false
  state.count += 1
  return true
}

/** Test-only reset — never called from production code. */
export function __resetCredentialSharingOrgRateLimitForTests(): void {
  orgRateLimitState.clear()
}

type AuditLogger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>

export type CredentialSharingHostContext = {
  /** Identifies the loaded extension's own accounting bucket — never shared across extensions,
   * never any other hook's own budget. */
  extensionName: string
  logger?: AuditLogger
  /** Test-only override of the per-extension in-flight cap. */
  maxInFlight?: number
  /** Test-only override of the per-org token-bucket limits. */
  orgRateLimits?: {
    findShareByToken?: number
    revealShare?: number
    windowMs?: number
  }
  /** Test-only clock override. */
  now?: () => number
}

/**
 * AC5 — structured audit-log entry recorded on EVERY call to a `credentialSharing` method
 * (success, denial, or error). Fields are `organizationId`/`extensionName`/`method`/`outcome`
 * only — never share content, tokens, or revealed values.
 */
function recordCredentialSharingHostAudit(
  logger: AuditLogger,
  fields: { extensionName: string; organizationId: string; method: string; outcome: string }
): void {
  try {
    operationalLog(
      logger,
      'info',
      OperationalEvent.CREDENTIAL_SHARING_HOST_CHECK_RECORDED,
      'HostServices.credentialSharing call recorded',
      fields
    )
  } catch {
    // Never let an audit-logging failure surface to the caller.
  }
}

/**
 * AC5 — wraps a `credentialSharing` method call with (a) per-extension rate-limiting via a
 * distinct in-flight budget and (b) a structured audit-log entry recorded on every outcome
 * (success, denial, or error).
 */
async function callOutOfRequestMethod<T>(
  methodName: string,
  organizationId: string,
  hostContext: CredentialSharingHostContext,
  fn: () => Promise<T>
): Promise<T> {
  const logger = hostContext.logger ?? {}
  const accountingKey = accountingKeyFor(hostContext.extensionName)
  const maxInFlight = hostContext.maxInFlight ?? CREDENTIAL_SHARING_HOST_MAX_IN_FLIGHT_PER_EXTENSION

  if (!tryAcquireSlot(accountingKey, maxInFlight)) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.CREDENTIAL_SHARING_HOST_RATE_LIMITED,
      `credentialSharing.${methodName}() call denied without invoking resolution — extension at its in-flight cap`,
      { extensionName: hostContext.extensionName }
    )
    recordCredentialSharingHostAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId,
      method: methodName,
      outcome: 'rate-limited',
    })
    throw new CredentialSharingRateLimitedError(methodName)
  }

  try {
    const result = await fn()
    recordCredentialSharingHostAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId,
      method: methodName,
      outcome: 'ok',
    })
    return result
  } catch (error) {
    recordCredentialSharingHostAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId,
      method: methodName,
      outcome: 'error',
    })
    throw error
  } finally {
    releaseSlot(accountingKey)
  }
}

/**
 * AC5b (Design Decision B) — the per-org token-bucket gate for `findShareByToken`/`revealShare`.
 * Applied AFTER the org has been resolved from the token (never before — the org is unknown until
 * then), but BEFORE any further DB work beyond the resolution lookup itself. Denial is
 * audit-logged the same way a per-extension rate-limit denial is.
 */
/** Extracted from `enforceOrgRateLimit` purely to keep that function's cyclomatic complexity
 * under this repo's eslint threshold — resolves the effective per-org cap for whichever of the
 * two rate-limited methods is calling. */
function orgRateLimitMaxFor(
  methodName: 'findShareByToken' | 'revealShare',
  hostContext: CredentialSharingHostContext
): number {
  if (methodName === 'findShareByToken') {
    return (
      hostContext.orgRateLimits?.findShareByToken ??
      CREDENTIAL_SHARING_FIND_SHARE_BY_TOKEN_ORG_LIMIT
    )
  }
  return hostContext.orgRateLimits?.revealShare ?? CREDENTIAL_SHARING_REVEAL_SHARE_ORG_LIMIT
}

function enforceOrgRateLimit(
  methodName: 'findShareByToken' | 'revealShare',
  organizationId: string,
  hostContext: CredentialSharingHostContext
): void {
  const logger = hostContext.logger ?? {}
  const now = (hostContext.now ?? Date.now)()
  const windowMs =
    hostContext.orgRateLimits?.windowMs ?? CREDENTIAL_SHARING_ORG_RATE_LIMIT_WINDOW_MS
  const max = orgRateLimitMaxFor(methodName, hostContext)

  const key = orgRateLimitKeyFor(methodName, organizationId)
  if (!tryAcquireOrgRateLimitSlot(key, max, windowMs, now)) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.CREDENTIAL_SHARING_HOST_ORG_RATE_LIMITED,
      `credentialSharing.${methodName}() call denied — per-org rate limit exceeded`,
      { extensionName: hostContext.extensionName, organizationId }
    )
    recordCredentialSharingHostAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId,
      method: methodName,
      outcome: 'org-rate-limited',
    })
    throw new CredentialSharingOrgRateLimitedError(methodName)
  }
}

// -------------------------------------------------------------------------------------------
// Design Decision A (Nestor-confirmed) — machine-user attribution resolution for
// createExternalShare/revokeShare/supersedeSharesForRotation. Fail closed: throws
// CredentialSharingNoMachineUserError if the calling extension's org has no mapped, live PV
// machine-user. The mapping convention: a `machine_users` row in the caller's org whose `name`
// exactly matches the calling extension's manifest name, with a live (non-revoked, non-expired,
// non-deactivated-owner) `api_keys` row — the same "is this key usable" predicate
// `key-validity.ts#isMachineKeyLive` already applies elsewhere in this codebase.
// -------------------------------------------------------------------------------------------

/**
 * `sharedByUserId` is a real `users.id` (the `credential_shares.shared_by` column's FK target is
 * `users`, not `machine_users` — the two tables are structurally distinct, see
 * `packages/db/src/schema/credential-shares.ts`/`machine-users.ts`). The resolved machine user's
 * own `createdBy` (the human who provisioned it) is what's persisted into that FK'd column, while
 * `machineUserId`/`keyId` are what `writeMachineAuditEntry` attributes the audit write to — these
 * are two independent facts about the same resolved mapping, not a substitution of one for the
 * other. If a machine user somehow has no `createdBy` (its FK is nullable, `onDelete: 'set null'`
 * on the owning human's own deletion), it cannot safely satisfy the NOT NULL `shared_by` FK either
 * — treated the same as "no machine-user mapped" (fail closed).
 */
type ResolvedMachineUser = { machineUserId: string; keyId: string; sharedByUserId: string }

async function resolveMachineUserForExtension(
  tx: Tx,
  organizationId: string,
  extensionName: string
): Promise<ResolvedMachineUser | null> {
  const rows = await tx
    .select({
      machineUserId: machineUsers.id,
      keyId: apiKeys.id,
      createdBy: machineUsers.createdBy,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      machineUserDeactivatedAt: machineUsers.deactivatedAt,
    })
    .from(machineUsers)
    .innerJoin(apiKeys, eq(apiKeys.machineUserId, machineUsers.id))
    .where(
      and(
        eq(machineUsers.orgId, organizationId),
        eq(machineUsers.name, extensionName),
        isNull(machineUsers.deactivatedAt)
      )
    )

  const live = rows.find((row) => isMachineKeyLive(row) && row.createdBy !== null)
  if (!live || !live.createdBy) return null
  return { machineUserId: live.machineUserId, keyId: live.keyId, sharedByUserId: live.createdBy }
}

async function requireMachineUserForExtension(
  tx: Tx,
  organizationId: string,
  extensionName: string,
  methodName: string,
  logger: AuditLogger
): Promise<ResolvedMachineUser> {
  const resolved = await resolveMachineUserForExtension(tx, organizationId, extensionName)
  if (resolved) return resolved
  operationalLog(
    logger,
    'warn',
    OperationalEvent.CREDENTIAL_SHARING_HOST_NO_MACHINE_USER,
    `credentialSharing.${methodName}() rejected — no mapped PV machine-user for this extension's org`,
    { extensionName, organizationId }
  )
  throw new CredentialSharingNoMachineUserError(methodName)
}

// -------------------------------------------------------------------------------------------
// Serialization — plain, serializable mirror of a CredentialShareRow. tokenHash is NEVER
// exposed.
// -------------------------------------------------------------------------------------------

function serializeShare(share: CredentialShareRow) {
  return {
    id: share.id,
    orgId: share.orgId,
    credentialId: share.credentialId,
    fieldKey: share.fieldKey,
    attributeKeys: share.attributeKeys,
    recipientType: share.recipientType as 'user' | 'external',
    recipientUserId: share.recipientUserId,
    recipientEmail: share.recipientEmail,
    singleUse: share.singleUse,
    createdAt: share.createdAt.toISOString(),
    expiresAt: share.expiresAt.toISOString(),
    revokedAt: share.revokedAt ? share.revokedAt.toISOString() : null,
    supersededAt: share.supersededAt ? share.supersededAt.toISOString() : null,
    firstViewedAt: share.firstViewedAt ? share.firstViewedAt.toISOString() : null,
    viewCount: share.viewCount,
    status: share.status as 'active' | 'viewed' | 'revoked' | 'expired' | 'superseded',
  }
}

/**
 * Story 20.12 — the real `HostServices.credentialSharing` implementation, bound to the loading
 * extension's own manifest by `loader.ts`'s `buildHostServices()`. Every method is a thin closure
 * over PV's real, already-shipped `credential-shares` service-layer functions (AC2/AC3/AC4/AC6) —
 * no parallel reimplementation of validation, caps, RLS-exception handling, or the atomic
 * single-use claim.
 */
export function buildCredentialSharingHost(
  manifest: ExtensionManifest,
  logger: AuditLogger = {},
  /** Test-only override seam — never used in production wiring. */
  overrides: {
    maxInFlight?: number
    orgRateLimits?: CredentialSharingHostContext['orgRateLimits']
    now?: () => number
  } = {}
): CredentialSharingHost {
  const hostContext: CredentialSharingHostContext = {
    extensionName: manifest.name,
    logger,
    ...(overrides.maxInFlight !== undefined ? { maxInFlight: overrides.maxInFlight } : {}),
    ...(overrides.orgRateLimits !== undefined ? { orgRateLimits: overrides.orgRateLimits } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  }

  return {
    async createExternalShare(params) {
      return callOutOfRequestMethod('createExternalShare', params.organizationId, hostContext, () =>
        withOrg(params.organizationId, async (tx) => {
          const machineUser = await requireMachineUserForExtension(
            tx,
            params.organizationId,
            manifest.name,
            'createExternalShare',
            logger
          )

          const result = await createExternalCredentialShare(tx, {
            orgId: params.organizationId,
            projectId: params.projectId,
            credentialId: params.credentialId,
            sharedByUserId: machineUser.sharedByUserId,
            recipientEmail: params.recipientEmail,
            fieldKey: params.fieldKey,
            attributeKeys: params.attributeKeys,
            expiresAt: new Date(params.expiresAt),
          })

          if (result.status !== 'ok') return result

          await writeMachineAuditEntry(tx, {
            orgId: params.organizationId,
            eventType: AuditEvent.CREDENTIAL_SHARE_CREATED,
            resourceId: result.share.id,
            resourceType: 'credential_share',
            machineUserId: machineUser.machineUserId,
            keyId: machineUser.keyId,
            payload: {
              credentialId: result.share.credentialId,
              fieldKey: result.share.fieldKey,
              attributeKeys: result.share.attributeKeys,
              recipientType: 'external',
            },
          })

          return { status: 'ok', share: serializeShare(result.share), token: result.token }
        })
      )
    },

    async findShareByToken(rawToken) {
      // AC3: org is unknown until the token resolves — this method never receives/takes an
      // organizationId. The per-extension in-flight cap alone would gate here on an unknown org
      // key; instead this call is wrapped with a synthetic 'unresolved' key for the in-flight
      // accounting (AC5's own per-extension budget, independent of the token's own org), and the
      // per-org token-bucket (AC5b) is only enforced once the org is actually known.
      return callOutOfRequestMethod('findShareByToken', 'unresolved', hostContext, async () => {
        const result = await findExternalShareByTokenHash(rawToken)
        if (result.status !== 'ok') return { status: 'not_found' as const }

        enforceOrgRateLimit('findShareByToken', result.metadata.share.orgId, hostContext)

        return {
          status: 'ok' as const,
          share: serializeShare(result.metadata.share),
          credentialName: result.metadata.credentialName,
          credentialProjectId: result.metadata.credentialProjectId,
          sharedByDisplayName: result.metadata.sharedByDisplayName,
        }
      })
    },

    async revealShare(rawToken) {
      return callOutOfRequestMethod('revealShare', 'unresolved', hostContext, async () => {
        // AC3's timing-safe lookup happens inside revealExternalShare itself; this facade cannot
        // resolve the org (to apply the AC5b org rate limit) without first doing the same
        // admin-connection lookup revealExternalShare performs internally. Reusing
        // findExternalShareByTokenHash here (read-only, no mutation, no attempt-counter increment)
        // purely to resolve the org for rate-limiting BEFORE calling the real reveal step —
        // mirrors AC3's own "hash + query unconditionally" timing-safety discipline (never an
        // early return before this lookup runs).
        const lookup = await findExternalShareByTokenHash(rawToken)
        if (lookup.status === 'ok') {
          enforceOrgRateLimit('revealShare', lookup.metadata.share.orgId, hostContext)
        }

        const result = await revealExternalShare(rawToken)
        if (result.status !== 'ok') return result
        return {
          status: 'ok' as const,
          share: serializeShare(result.share),
          value: result.value,
          valueFormat: result.valueFormat,
          fieldKey: result.fieldKey,
        }
      })
    },

    async revokeShare(params) {
      return callOutOfRequestMethod('revokeShare', params.organizationId, hostContext, () =>
        withOrg(params.organizationId, async (tx) => {
          const machineUser = await requireMachineUserForExtension(
            tx,
            params.organizationId,
            manifest.name,
            'revokeShare',
            logger
          )

          const result = await revokeShareService(tx, {
            orgId: params.organizationId,
            credentialId: params.credentialId,
            shareId: params.shareId,
          })

          if (result.status !== 'ok') return result
          if (result.alreadyTerminal) {
            return {
              status: 'ok' as const,
              share: serializeShare(result.share),
              alreadyTerminal: true,
            }
          }

          await writeMachineAuditEntry(tx, {
            orgId: params.organizationId,
            eventType: AuditEvent.CREDENTIAL_SHARE_REVOKED,
            resourceId: result.share.id,
            resourceType: 'credential_share',
            machineUserId: machineUser.machineUserId,
            keyId: machineUser.keyId,
            payload: {
              credentialId: result.share.credentialId,
              recipientType: result.share.recipientType,
            },
          })

          return {
            status: 'ok' as const,
            share: serializeShare(result.share),
            alreadyTerminal: false,
          }
        })
      )
    },

    async supersedeSharesForRotation(params) {
      return callOutOfRequestMethod(
        'supersedeSharesForRotation',
        params.organizationId,
        hostContext,
        () =>
          withOrg(params.organizationId, async (tx) => {
            const machineUser = await requireMachineUserForExtension(
              tx,
              params.organizationId,
              manifest.name,
              'supersedeSharesForRotation',
              logger
            )

            const superseded = await supersedeOutstandingSharesForRotationService(tx, {
              orgId: params.organizationId,
              credentialId: params.credentialId,
              targetFields: params.targetFields,
              rotationId: params.rotationId,
            })

            // One audit entry per superseded share, mirroring rotation/routes.ts's own AC-13
            // per-share write; these are sequential writes into the same transaction's audit
            // chain and cannot be parallelized without corrupting the HMAC chain ordering.
            for (const share of superseded) {
              await writeMachineAuditEntry(tx, {
                orgId: params.organizationId,
                eventType: AuditEvent.CREDENTIAL_SHARE_SUPERSEDED,
                resourceId: share.id,
                resourceType: 'credential_share',
                machineUserId: machineUser.machineUserId,
                keyId: machineUser.keyId,
                payload: {
                  credentialId: share.credentialId,
                  rotationId: params.rotationId,
                },
              })
            }

            return { supersededShares: superseded.map(serializeShare) }
          })
      )
    },
  }
}
