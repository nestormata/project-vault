import { z } from 'zod/v4'
import { PageLimitQueryShape } from '../../lib/pagination.js'
import { paginatedListMetaFields } from '../../lib/api-contracts.js'

/** AC-20: vaultGuard's own onRequest hook (fires before any handler) sends this exact
 * `{status, message}` shape whenever the vault is sealed — every route here that declares a 503
 * response must include this in its union, or vaultGuard's body fails this route's compiled
 * response serializer (silent 500 instead of the intended 503). Same shape as
 * `modules/backup/schema.ts`/`modules/platform-admin/route-common.ts`'s own independent copies —
 * intentionally not imported across modules (see this module's route-audit regression guard). */
export const VaultSealedResponseSchema = z.object({ status: z.string(), message: z.string() })

/**
 * Story 9.4 AC-9: matches the existing `PaginationQuerySchema` offset-pagination convention
 * (`modules/machine-users/schema.ts`) rather than inventing a cursor scheme.
 */
export const PlatformAuditEventsQuerySchema = z
  .object({
    operatorId: z.uuid().optional(),
    actionType: z.string().min(1).optional(),
    targetOrgId: z.uuid().optional(),
    targetUserId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    ...PageLimitQueryShape,
  })
  .strict()
  .meta({ id: 'PlatformAuditEventsQuery' })

export type PlatformAuditEventsQuery = z.infer<typeof PlatformAuditEventsQuerySchema>

export const PlatformAuditEventItemSchema = z
  .object({
    id: z.uuid(),
    operatorId: z.uuid(),
    actionType: z.string(),
    targetOrgId: z.uuid().nullable(),
    targetUserId: z.uuid().nullable(),
    payload: z.record(z.string(), z.unknown()),
    ipAddress: z.string().nullable(),
    timestamp: z.string(),
  })
  .meta({ id: 'PlatformAuditEventItem' })

export const PlatformAuditEventsResponseSchema = z
  .object({
    data: z.object({
      items: z.array(PlatformAuditEventItemSchema),
      ...paginatedListMetaFields,
    }),
  })
  .meta({ id: 'PlatformAuditEventsResponse' })

export const PlatformAuditVerifyQuerySchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .strict()
  .meta({ id: 'PlatformAuditVerifyQuery' })

export type PlatformAuditVerifyQuery = z.infer<typeof PlatformAuditVerifyQuerySchema>

export const PlatformAuditVerifyFailedEntrySchema = z
  .object({
    id: z.uuid(),
    actionType: z.string(),
    timestamp: z.string(),
  })
  .meta({ id: 'PlatformAuditVerifyFailedEntry' })

export const PlatformAuditVerifyResultSchema = z
  .object({
    summary: z.string(),
    rowsChecked: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.array(PlatformAuditVerifyFailedEntrySchema),
    failedCount: z.number().int().min(0),
    failedTruncated: z.boolean(),
    verifiedAt: z.string(),
  })
  .meta({ id: 'PlatformAuditVerifyResult' })

export const PlatformAuditVerifyResponseSchema = z
  .object({ data: PlatformAuditVerifyResultSchema })
  .meta({ id: 'PlatformAuditVerifyResponse' })

/**
 * Story 9.4 AC-14/AC-16: `{ reason }` or `{ action: 'activate', reason }` activates; `{ action:
 * 'deactivate' }` deactivates (no reason needed/accepted). `reason` is required whenever the
 * effective action is "activate" — an un-reasoned activation is not permitted (AC-14 edge case).
 */
export const MaintenanceModeBodySchema = z
  .object({
    action: z.enum(['activate', 'deactivate']).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action !== 'deactivate' && !value.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'reason is required' })
    }
  })
  .meta({ id: 'MaintenanceModeBody' })

export type MaintenanceModeBody = z.infer<typeof MaintenanceModeBodySchema>

export const MaintenanceModeActivateResponseSchema = z
  .object({
    active: z.literal(true),
    activatedAt: z.string(),
    reason: z.string(),
  })
  .meta({ id: 'MaintenanceModeActivateResponse' })

export const MaintenanceModeDeactivateResponseSchema = z
  .object({
    active: z.literal(false),
    deactivatedAt: z.string(),
  })
  .meta({ id: 'MaintenanceModeDeactivateResponse' })

export const MaintenanceModeStatusResponseSchema = z
  .object({
    data: z.object({
      active: z.boolean(),
      reason: z.string().nullable(),
      activatedAt: z.string().nullable(),
      deactivatedAt: z.string().nullable(),
      pendingEntriesCount: z.number().int().min(0),
    }),
  })
  .meta({ id: 'MaintenanceModeStatusResponse' })
