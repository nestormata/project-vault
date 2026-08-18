import { z } from 'zod/v4'

/**
 * Story 9.2 D2/D3: platform-operator-scoped (instance-wide) request/response schemas. Do NOT
 * confuse with apps/api/src/modules/admin/schema.ts (org-scoped org-admin schemas) — see D2.
 */

// ---- GET /admin/settings response / PUT /admin/settings response (same shape) -------------

export const EffectiveSmtpSettingsSchema = z.object({
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  user: z.string().nullable(),
  from: z.string().nullable(),
  configured: z.boolean(),
})

export const EffectiveBackupSettingsSchema = z.object({
  schedule: z.string(),
  retentionCount: z.number().int(),
  storageType: z.enum(['filesystem', 's3']).nullable(),
})

export const EffectiveNotificationSettingsSchema = z.object({
  defaultSlackWebhook: z.string().nullable(),
})

export const EffectiveInstancePolicySchema = z.object({
  maxOrgs: z.number().int().describe('Hard-enforced — POST /admin/orgs rejects the (n+1)th org.'),
  // D3 point 3: intentionally NOT symmetric with maxOrgs — advisory only in v1 (alerts at
  // 80/90/95%, AC-13), does not block new members joining via any existing org-join mechanism.
  // Documented here so a platform operator reading this field doesn't form a false expectation
  // of a hard cap.
  maxUsersPerOrg: z
    .number()
    .int()
    .describe('Advisory only in v1 — alerts at 80/90/95%, does not block new members.'),
  sessionIdleTimeoutMinutes: z.number().int(),
})

export const SystemSettingsResponseSchema = z.object({
  smtp: EffectiveSmtpSettingsSchema,
  backup: EffectiveBackupSettingsSchema,
  notifications: EffectiveNotificationSettingsSchema,
  instancePolicy: EffectiveInstancePolicySchema,
})

export type SystemSettingsResponse = z.infer<typeof SystemSettingsResponseSchema>

// ---- PUT /admin/settings request (partial update) ------------------------------------------

export const SystemSettingsUpdateSchema = z.object({
  smtp: z
    .object({
      host: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      secure: z.boolean().optional(),
      user: z.string().optional(),
      from: z.string().email().optional(),
      // The literal "[configured]" sentinel is special-cased as "omitted" in service.ts (AC-3
      // negative case) — never persisted as a real password.
      password: z.string().min(1).optional(),
    })
    .optional(),
  backup: z
    .object({
      scheduleOverride: z.string().min(1).optional(),
      retentionCountOverride: z.number().int().min(1).optional(),
    })
    .optional(),
  notifications: z
    .object({
      defaultSlackWebhookUrl: z.url().optional(),
    })
    .optional(),
  instancePolicy: z
    .object({
      maxOrgs: z.number().int().min(1).optional(),
      maxUsersPerOrg: z.number().int().min(1).optional(),
      sessionIdleTimeoutMinutes: z.number().int().min(1).optional(),
    })
    .optional(),
})

export type SystemSettingsUpdate = z.infer<typeof SystemSettingsUpdateSchema>

// ---- POST /admin/orgs ------------------------------------------------------------------------

export const CreateOrgRequestSchema = z.object({
  name: z.string().min(1),
  ownerEmail: z.email(),
})

export type CreateOrgRequest = z.infer<typeof CreateOrgRequestSchema>

export const CreateOrgResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  ownerAccountAction: z.enum(['existing_user_added', 'invited_new_user']),
  ownerUserId: z.string(),
})

export type CreateOrgResponse = z.infer<typeof CreateOrgResponseSchema>

// ---- GET /admin/orgs -------------------------------------------------------------------------

export const OrgListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  memberCount: z.number().int(),
})

export const OrgListResponseSchema = z.object({
  items: z.array(OrgListItemSchema),
})

export type OrgListResponse = z.infer<typeof OrgListResponseSchema>

// ---- GET /admin/resource-usage ----------------------------------------------------------------

// Story 22.3 AC-1: per-org audit-storage visibility, additive to the existing response.
export const OrgAuditStateSchema = z.enum([
  'unlimited',
  'ok',
  'warning',
  'critical',
  'blocked',
  'stale',
])

export const AuditStorageOrgRowSchema = z.object({
  orgId: z.string(),
  orgName: z.string(),
  bytesUsed: z.number(),
  preauthBytesUsed: z.number(),
  quotaBytes: z.number().nullable(),
  utilizationPct: z.number().nullable(),
  refusedWriteCount: z.number().int(),
  lastRefusalAt: z.string().nullable(),
  lastReconciledAt: z.string().nullable(),
  writeRatePerMinute: z.number().nullable(),
  rateWindowCount: z.number().int(),
  rateRefusedCount: z.number().int(),
  state: OrgAuditStateSchema,
})

export type AuditStorageOrgRow = z.infer<typeof AuditStorageOrgRowSchema>

export const ResourceUsageResponseSchema = z.object({
  orgs: z.object({ current: z.number().int(), limit: z.number().int().nullable() }),
  usersPerOrg: z.array(
    z.object({
      orgId: z.string(),
      current: z.number().int(),
      limit: z.number().int().nullable(),
    })
  ),
  secretsPerProject: z.array(
    z.object({
      projectId: z.string(),
      orgId: z.string(),
      current: z.number().int(),
    })
  ),
  auditLogEntries: z.object({ current: z.number().int(), limit: z.number().int().nullable() }),
  storageBytes: z.object({ current: z.number(), limit: z.number().nullable() }),
  auditLogStorage: z.object({
    currentBytes: z.number(),
    limitBytes: z.number(),
    utilizationPct: z.number(),
  }),
  // Story 22.3 AC-1/AC-4/AC-7: additive fields — per-org audit-storage rows, the cap/truncation
  // indicator, and the aggregate-allocation (overcommit) figures shown on every GET (not only
  // computed on write).
  auditStorageByOrg: z.array(AuditStorageOrgRowSchema),
  truncated: z.boolean(),
  allocatedLogicalBytes: z.number(),
  estimatedPhysicalBytes: z.number(),
  allocationIncludesUnlimitedOrgs: z.boolean(),
  observedPhysicalToLogicalRatio: z.number().nullable(),
})

export type ResourceUsageResponse = z.infer<typeof ResourceUsageResponseSchema>

// ---- PUT /admin/orgs/:orgId/audit-quota -------------------------------------------------------

export const OrgIdParamsSchema = z.object({ orgId: z.string() })

const SAFE_INTEGER_MSG = 'must be a safe integer (bigint values beyond 2^53-1 are not supported)'

export const SetOrgAuditQuotaRequestSchema = z.object({
  quotaBytes: z
    .union([z.number().int().positive().refine(Number.isSafeInteger, SAFE_INTEGER_MSG), z.null()])
    .optional(),
  writeRatePerMinute: z
    .union([z.number().int().positive().refine(Number.isSafeInteger, SAFE_INTEGER_MSG), z.null()])
    .optional(),
  acknowledgeOvercommit: z.boolean().optional(),
})

export type SetOrgAuditQuotaRequest = z.infer<typeof SetOrgAuditQuotaRequestSchema>

export const QuotaOvercommitErrorSchema = z.object({
  code: z.literal('quota_overcommit'),
  message: z.string(),
  allocatedLogicalBytes: z.number(),
  estimatedPhysicalBytes: z.number(),
  instanceLimitBytes: z.number(),
  requestedBytes: z.number(),
  allocationIncludesUnlimitedOrgs: z.boolean(),
})
