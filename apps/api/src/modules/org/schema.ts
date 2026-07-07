import { z } from 'zod/v4'
import { paginatedListMetaFields } from '../../lib/api-contracts.js'

export const OrgUserParamsSchema = z.object({
  userId: z.uuid(),
})

export type OrgUserParams = z.infer<typeof OrgUserParamsSchema>

export const OrgUserProjectRoleParamsSchema = z.object({
  userId: z.uuid(),
  projectId: z.uuid(),
})

export type OrgUserProjectRoleParams = z.infer<typeof OrgUserProjectRoleParamsSchema>

// Story 4.3 AC-2: deactivation response — revokedSessionCount/revokedInvitationCount reflect the
// actual work performed in the same transaction (AC-5/AC-7).
export const OrgUserDeactivatedResponseSchema = z
  .object({
    data: z.object({
      userId: z.uuid(),
      revokedSessionCount: z.number().int().nonnegative(),
      revokedInvitationCount: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'OrgUserDeactivatedResponse' })

// Story 4.3 AC-10: admin-initiated recovery link response.
export const AdminRecoveryLinkResponseSchema = z
  .object({
    data: z.object({
      userId: z.uuid(),
      linkSent: z.boolean(),
    }),
  })
  .meta({ id: 'AdminRecoveryLinkResponse' })

// D6: 'owner' is intentionally excluded — ownership changes hands only via
// POST /projects/:projectId/transfer-ownership, never through this role-change endpoint.
export const ProjectRoleChangeBodySchema = z
  .object({ role: z.enum(['admin', 'member', 'viewer']) })
  .strict()
  .meta({ id: 'ProjectRoleChangeBody' })

export type ProjectRoleChangeBody = z.infer<typeof ProjectRoleChangeBodySchema>

const orgProjectRoleEnum = z.enum(['owner', 'admin', 'member', 'viewer'])

export const OrgUsersListResponseSchema = z
  .object({
    data: z.array(
      z.object({
        userId: z.uuid(),
        email: z.string(),
        displayName: z.string(),
        orgRole: orgProjectRoleEnum,
        status: z.enum(['active', 'deactivated']),
        projects: z.array(
          z.object({
            projectId: z.uuid(),
            projectName: z.string(),
            role: orgProjectRoleEnum,
          })
        ),
      })
    ),
  })
  .meta({ id: 'OrgUsersListResponse' })

export const OrgUserRemovedResponseSchema = z
  .object({
    data: z.object({
      userId: z.uuid(),
      revokedSessionCount: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'OrgUserRemovedResponse' })

// D5 item 2: the 409 body for a sole-project-owner block carries the offending projects so the
// caller can transfer ownership. A plain ApiError schema would strip `projects` during response
// serialization, so this endpoint needs its own 409 shape.
export const SoleOwnerConflictResponseSchema = z
  .object({
    code: z.literal('sole_owner_of_projects'),
    message: z.string(),
    projects: z.array(
      z.object({
        projectId: z.uuid(),
        projectName: z.string(),
      })
    ),
  })
  .meta({ id: 'SoleOwnerConflictResponse' })

export const ProjectRoleChangeResponseSchema = z
  .object({
    data: z.object({
      userId: z.uuid(),
      projectId: z.uuid(),
      role: orgProjectRoleEnum,
    }),
  })
  .meta({ id: 'ProjectRoleChangeResponse' })

export const failedAuthThresholdPayloadSchema = z
  .object({
    thresholdType: z.enum(['ip', 'account']),
    thresholdCount: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
    attemptCount: z.number().int().min(1),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    ipAddress: z.string().optional(),
    userId: z.uuid().optional(),
    attemptedEmail: z.email().optional(),
  })
  .strict()

// Story 6.2 AC 11/12, ADR-6.2-06/ADR-6.2-07: payload shape for `security.anomalous_access`
// alerts — distinct from failedAuthThresholdPayloadSchema above, which is why
// listSecurityAlertsWithTx must select a schema by alertType rather than hardcoding one.
export const anomalousAccessPayloadSchema = z
  .object({
    actorTokenId: z.uuid().nullable(),
    revealedCount: z.number().int(),
    // Capped at 50 (adversarial-review finding 9): a best-effort investigative aid, not a
    // complete audit trail — the full detail remains queryable via audit_log_entries directly.
    revealedCredentialIds: z.array(z.uuid()).max(50),
    windowSeconds: z.number().int(),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
  })
  .strict()

// Story 6.2 AC 18 (ADR-6.2-04's correction): org-admin-only dismiss for the pre-existing
// security_alerts table's unused dismissedBy/dismissedAt/dismissalReason columns.
export const SecurityAlertDismissBodySchema = z
  .object({ dismissalReason: z.string().max(1000).optional() })
  .strict()
  .meta({ id: 'SecurityAlertDismissBody' })

export type SecurityAlertDismissBody = z.infer<typeof SecurityAlertDismissBodySchema>

export const SecurityAlertParamsSchema = z.object({ securityAlertId: z.uuid() })
export type SecurityAlertParams = z.infer<typeof SecurityAlertParamsSchema>

// Story 7.2 D9 — dormancy alerts reuse security_alerts; this is the first-ever payload schema
// for a machine-key alert type, extending the previously failed-auth-threshold-only union so the
// existing list endpoint can render both alert types without a schema-mismatch warning.
export const machineKeyDormantPayloadSchema = z
  .object({
    keyId: z.uuid(),
    machineUserId: z.uuid(),
    machineUserName: z.string(),
    lastUsedAt: z.iso.datetime().nullable(),
    projectId: z.uuid(),
    keyName: z.string(),
  })
  .strict()

// Story 8.3 D5/D6/AC-10 — user-dormancy alerts reuse security_alerts (same table, new
// alertType), mirroring machineKeyDormantPayloadSchema's shape/precedent above.
export const userDormantPayloadSchema = z
  .object({
    userId: z.uuid(),
    displayName: z.string(),
    orgRole: z.enum(['owner', 'admin', 'member', 'viewer']),
    lastActiveAt: z.iso.datetime().nullable(),
  })
  .strict()

export const securityAlertPayloadSchema = z.union([
  failedAuthThresholdPayloadSchema,
  anomalousAccessPayloadSchema,
  machineKeyDormantPayloadSchema,
  userDormantPayloadSchema,
])

export const SecurityAlertsQuerySchema = z.object({
  status: z.enum(['PENDING_DELIVERY', 'delivered', 'dismissed', 'all']).default('all'),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

// Story 8.3 AC-17/AC-17a — `confirmUserId` must exactly match the target `userId` (re-typing the
// identifier to confirm an irreversible, cross-org-impacting action), rejected with 422
// `confirmation_required` otherwise, before any mutation.
export const PseudonymizeBodySchema = z
  .object({ confirmUserId: z.uuid().optional() })
  .strict()
  .meta({ id: 'PseudonymizeBody' })

export const PseudonymizeResponseSchema = z
  .object({
    data: z.object({
      userId: z.uuid(),
      pseudonymized: z.literal(true),
      pseudonymizedAt: z.iso.datetime(),
      alias: z.string(),
      // D9/AC-17a — surfaces the cross-org blast radius to the calling owner at the moment of
      // this irreversible action, rather than leaving it to be discovered later (AC-22).
      otherAffectedOrgCount: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'PseudonymizeResponse' })

export const securityAlertsResponseSchema = z.object({
  data: z.object({
    items: z.array(
      z.object({
        id: z.uuid(),
        alertType: z.string(),
        severity: z.enum(['info', 'warning', 'critical']),
        status: z.enum(['PENDING_DELIVERY', 'delivered', 'dismissed']),
        payload: securityAlertPayloadSchema,
        deliveryStatus: z.enum(['pending_notification_channel', 'delivered', 'dismissed']),
        createdAt: z.iso.datetime(),
      })
    ),
    ...paginatedListMetaFields,
  }),
})

export type SecurityAlertsQuery = z.infer<typeof SecurityAlertsQuerySchema>
