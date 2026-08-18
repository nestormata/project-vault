// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/
// (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).
import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { organizations } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { AppError } from '../../lib/errors.js'
import { operationalLog } from '../../lib/logger.js'
import { parseParams } from '../../lib/route-helpers.js'
import {
  secureRoute,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import {
  computeAuditQuotaAllocation,
  resolveEffectiveOrgQuotaBytes,
  resolveOrgAuditState,
  resolveOrgQuotaAllocationAggregate,
  setOrgAuditQuota,
} from '../audit/quota-config.js'
import {
  AuditStorageOrgRowSchema,
  OrgIdParamsSchema,
  QuotaOvercommitErrorSchema,
  SetOrgAuditQuotaRequestSchema,
} from './schema.js'
import {
  PLATFORM_ADMIN_ERROR_RESPONSES,
  PLATFORM_ADMIN_TAGS,
  beginSecureMutation,
  sendPlatformAuditWriteFailure,
} from './route-common.js'

const ORG_NOT_FOUND = { code: 'org_not_found', message: 'Organization not found' } as const

class OrgNotFoundError extends AppError {
  constructor() {
    super(ORG_NOT_FOUND.code, ORG_NOT_FOUND.message, 404)
  }
}

/**
 * Story 22.3 AC-4 — thrown (and rolled back) inside the transaction, then mapped to the full
 * `422 quota_overcommit` body by the route handler's outer catch. Carries every field the AC's
 * response shape requires — `AppError`'s base shape only has `code`/`message`.
 */
class QuotaOvercommitError extends AppError {
  constructor(
    public readonly allocatedLogicalBytes: number,
    public readonly estimatedPhysicalBytes: number,
    public readonly instanceLimitBytes: number,
    public readonly requestedBytes: number,
    public readonly allocationIncludesUnlimitedOrgs: boolean
  ) {
    super(
      'quota_overcommit',
      'This change would allocate more audit-storage than the instance can safely support. ' +
        'Resubmit with acknowledgeOvercommit: true to proceed anyway.',
      422
    )
  }
}

/**
 * Story 22.3 AC-3 — re-reads the org's fresh `AuditStorageOrgRow` AFTER the write (never the
 * stale pre-write values the operator's form was opened with — AC-10's self-correcting-display
 * requirement). Mirrors `resolveAuditStorageByOrg()`'s per-row shaping exactly (service.ts), but
 * scoped to a single org's row rather than the full instance-wide array.
 */
async function reloadAuditStorageOrgRow(
  tx: Tx,
  orgId: string
): Promise<ReturnType<typeof AuditStorageOrgRowSchema.parse>> {
  const rows = await tx.execute<{
    org_id: string
    org_name: string
    bytes_used: string
    preauth_bytes_used: string
    quota_bytes: string | null
    refused_write_count: string
    last_refusal_at: string | null
    last_reconciled_at: string | null
    write_rate_per_minute: string | null
    rate_window_count: string
    rate_refused_count: string
  }>(sql`
    SELECT
      o.id AS org_id,
      o.name AS org_name,
      COALESCE(u.bytes_used, 0) AS bytes_used,
      COALESCE(u.preauth_bytes_used, 0) AS preauth_bytes_used,
      u.last_refusal_at,
      u.last_reconciled_at,
      COALESCE(u.refused_write_count, 0) AS refused_write_count,
      COALESCE(u.rate_window_count, 0) AS rate_window_count,
      COALESCE(u.rate_refused_count, 0) AS rate_refused_count,
      q.quota_bytes,
      q.write_rate_per_minute
    FROM organizations o
    LEFT JOIN audit_org_storage_usage u ON u.org_id = o.id
    LEFT JOIN audit_storage_quota_config q ON q.org_id = o.id
    WHERE o.id = ${orgId}
  `)
  const row = rows[0]
  if (!row) throw new Error(`reloadAuditStorageOrgRow: org ${orgId} vanished mid-transaction`)

  const bytesUsed = Number(row.bytes_used)
  const effectiveQuotaBytes = await resolveEffectiveOrgQuotaBytes(tx, orgId)
  const lastReconciledAt = row.last_reconciled_at ? new Date(row.last_reconciled_at) : null
  const utilizationPct =
    effectiveQuotaBytes === null || effectiveQuotaBytes === 0
      ? null
      : Math.round((bytesUsed / effectiveQuotaBytes) * 10000) / 100

  return {
    orgId: row.org_id,
    orgName: row.org_name,
    bytesUsed,
    preauthBytesUsed: Number(row.preauth_bytes_used),
    quotaBytes: effectiveQuotaBytes,
    utilizationPct,
    refusedWriteCount: Number(row.refused_write_count),
    lastRefusalAt: row.last_refusal_at ? new Date(row.last_refusal_at).toISOString() : null,
    lastReconciledAt: lastReconciledAt ? lastReconciledAt.toISOString() : null,
    writeRatePerMinute:
      row.write_rate_per_minute === null ? null : Number(row.write_rate_per_minute),
    rateWindowCount: Number(row.rate_window_count),
    rateRefusedCount: Number(row.rate_refused_count),
    state: resolveOrgAuditState({ quotaBytes: effectiveQuotaBytes, bytesUsed, lastReconciledAt }),
  }
}

type OvercommitOutcome = {
  overcommitAcknowledged?: boolean
  estimatedPhysicalBytesAtTimeOfChange?: number
}

/**
 * Story 22.3 AC-4 — extracted from the route handler purely to keep the handler's own cognitive
 * complexity under this repo's eslint threshold; behavior is unchanged (still runs inside the
 * caller's open transaction, still throws QuotaOvercommitError to trigger a rollback).
 */
async function checkOvercommitForRaise(
  tx: Tx,
  req: FastifyRequest,
  operatorUserId: string,
  orgId: string,
  requestedQuotaBytes: number,
  acknowledgeOvercommit: boolean | undefined
): Promise<OvercommitOutcome> {
  const aggregate = await resolveOrgQuotaAllocationAggregate(tx, orgId)
  const allocation = computeAuditQuotaAllocation({
    currentSumOfFiniteQuotaBytes:
      aggregate.sumOfFiniteQuotaBytesExcludingTarget + aggregate.targetOrgCurrentContributionBytes,
    targetOrgCurrentContributionBytes: aggregate.targetOrgCurrentContributionBytes,
    requestedBytes: requestedQuotaBytes,
    hasUnlimitedOrgs: aggregate.hasUnlimitedOrgs,
  })

  if (!allocation.overThreshold) return {}

  if (acknowledgeOvercommit !== true) {
    operationalLog(
      req.log,
      'warn',
      OperationalEvent.PLATFORM_AUDIT_QUOTA_OVERCOMMIT_REJECTED,
      'platform-operator quota change rejected: aggregate-allocation overcommit',
      {
        operatorUserId,
        targetOrgId: orgId,
        allocatedLogicalBytes: allocation.allocatedLogicalBytes,
        estimatedPhysicalBytes: allocation.estimatedPhysicalBytes,
        instanceLimitBytes: allocation.instanceLimitBytes,
        requestedBytes: requestedQuotaBytes,
      }
    )
    throw new QuotaOvercommitError(
      allocation.allocatedLogicalBytes,
      allocation.estimatedPhysicalBytes,
      allocation.instanceLimitBytes,
      requestedQuotaBytes,
      allocation.allocationIncludesUnlimitedOrgs
    )
  }

  return {
    overcommitAcknowledged: true,
    estimatedPhysicalBytesAtTimeOfChange: allocation.estimatedPhysicalBytes,
  }
}

/**
 * Story 22.3 AC-4 — whether a proposed `quotaBytes` value requires the overcommit check at all.
 * A currently-UNLIMITED org (no per-org row and no positive env default, or an explicit per-org
 * NULL) moving to any finite value is always a "raise" that must be checked — going from
 * excluded-from-the-sum to included-with-a-finite-contribution can only ever increase the
 * aggregate, never decrease it, even though a literal `requestedBytes >
 * currentEffectiveQuotaBytes` comparison is vacuously false against `null`/infinity. Only a
 * genuine finite-to-lower-finite change skips the check.
 */
function isQuotaRaise(
  requestedQuotaBytes: number,
  currentEffectiveQuotaBytes: number | null
): boolean {
  return currentEffectiveQuotaBytes === null || requestedQuotaBytes > currentEffectiveQuotaBytes
}

async function handleSetOrgAuditQuota(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const params = parseParams(OrgIdParamsSchema, req, reply)
  if (!params) return reply
  const begun = beginSecureMutation(ctx, req, reply, SetOrgAuditQuotaRequestSchema)
  if (!begun) return reply
  const { secureCtx, data } = begun
  const { orgId } = params

  try {
    // Story 22.3's own route file opens its own transaction, mirroring orgs-routes.ts's
    // createOrg() and settings-routes.ts's upsertSystemSettings() — `requireOrgScope: false`
    // (mandatory for every modules/platform-admin/ route, AC-9) means secure-route.ts's own
    // machinery does NOT open a transaction or provide `secureCtx.tx` (see runProtectedHandler()'s
    // early-return branch for `!requireOrgScope`); this route needs one of its own to give
    // AC-3's 404 check, AC-4's overcommit read, and setOrgAuditQuota()'s dual-write one atomic
    // unit, exactly like the other two mutation routes in this module.
    const row = await getDb().transaction(async (tx) => {
      // AC-3: the 404 existence check runs BEFORE AC-4's overcommit calculation, and before
      // setOrgAuditQuota()'s own set_config() call — an invalid orgId must never trigger a
      // cross-org aggregate query or transiently set app.current_org_id to a target the operator
      // doesn't administer (AC-9).
      const [orgRow] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1)
      if (!orgRow) throw new OrgNotFoundError()

      // AC-4: the overcommit bound is only ever evaluated for a RAISE — never on a value that
      // lowers or clears the quota (a decrease can only reduce the aggregate, never increase risk).
      let overcommitOutcome: OvercommitOutcome = {}
      if (data.quotaBytes !== undefined && data.quotaBytes !== null) {
        const currentEffectiveQuotaBytes = await resolveEffectiveOrgQuotaBytes(tx, orgId)
        if (isQuotaRaise(data.quotaBytes, currentEffectiveQuotaBytes)) {
          overcommitOutcome = await checkOvercommitForRaise(
            tx,
            req,
            secureCtx.auth.userId,
            orgId,
            data.quotaBytes,
            data.acknowledgeOvercommit
          )
        }
      }
      const { overcommitAcknowledged, estimatedPhysicalBytesAtTimeOfChange } = overcommitOutcome

      await setOrgAuditQuota(tx, {
        orgId,
        quotaBytes: data.quotaBytes,
        writeRatePerMinute: data.writeRatePerMinute,
        operatorId: secureCtx.auth.userId,
        operatorIpAddress: req.ip,
        ...(overcommitAcknowledged !== undefined
          ? { overcommitAcknowledged, estimatedPhysicalBytesAtTimeOfChange }
          : {}),
      })

      const fieldsChanged = Object.keys(data).filter((key) => key !== 'acknowledgeOvercommit')
      operationalLog(
        req.log,
        'info',
        OperationalEvent.PLATFORM_AUDIT_QUOTA_UPDATED,
        'platform-operator updated org audit quota',
        {
          operatorUserId: secureCtx.auth.userId,
          targetOrgId: orgId,
          fieldsChanged,
          overcommitAcknowledged: overcommitAcknowledged ?? false,
        }
      )

      return reloadAuditStorageOrgRow(tx, orgId)
    })

    return reply.status(200).send(row)
  } catch (error) {
    if (error instanceof QuotaOvercommitError) {
      return reply.status(422).send({
        code: error.code,
        message: error.message,
        allocatedLogicalBytes: error.allocatedLogicalBytes,
        estimatedPhysicalBytes: error.estimatedPhysicalBytes,
        instanceLimitBytes: error.instanceLimitBytes,
        requestedBytes: error.requestedBytes,
        allocationIncludesUnlimitedOrgs: error.allocationIncludesUnlimitedOrgs,
      })
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message })
    }
    if (sendPlatformAuditWriteFailure(error, reply)) return reply
    throw error
  }
}

/**
 * Story 22.3 AC-3/AC-4/AC-9/AC-11/AC-12: `PUT /admin/orgs/:orgId/audit-quota` — sets, changes, or
 * clears an org's audit-storage quota and/or write-rate cap. `requireOrgScope: false` +
 * `requirePlatformOperator: true` + `requireMfa: true` — never `allowedRoles`, matching every
 * other file in `modules/platform-admin/`.
 */
export async function auditQuotaRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'PUT',
    url: '/orgs/:orgId/audit-quota',
    schema: {
      tags: PLATFORM_ADMIN_TAGS,
      body: SetOrgAuditQuotaRequestSchema,
      response: {
        200: AuditStorageOrgRowSchema,
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
        404: ApiErrorSchema,
        422: QuotaOvercommitErrorSchema.or(ApiErrorSchema),
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
      // Story 22.3 AC-3 Red Team finding: tighter than secure-route.ts's 60/min default — a
      // compromised/malicious operator session could otherwise fire this rapidly to probe AC-4's
      // accepted concurrent-overcommit race window or generate audit-log noise at will.
      rateLimit: { max: 20, timeWindowMs: 60_000 },
    },
    handler: handleSetOrgAuditQuota,
  })
}
