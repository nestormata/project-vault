import { z } from 'zod/v4'

export const OrgUserParamsSchema = z.object({
  userId: z.uuid(),
})

export type OrgUserParams = z.infer<typeof OrgUserParamsSchema>

export const OrgUserProjectRoleParamsSchema = z.object({
  userId: z.uuid(),
  projectId: z.uuid(),
})

export type OrgUserProjectRoleParams = z.infer<typeof OrgUserProjectRoleParamsSchema>

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

export const SecurityAlertsQuerySchema = z.object({
  status: z.enum(['PENDING_DELIVERY', 'delivered', 'dismissed', 'all']).default('all'),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const securityAlertsResponseSchema = z.object({
  data: z.object({
    items: z.array(
      z.object({
        id: z.uuid(),
        alertType: z.string(),
        severity: z.enum(['info', 'warning', 'critical']),
        status: z.enum(['PENDING_DELIVERY', 'delivered', 'dismissed']),
        payload: failedAuthThresholdPayloadSchema,
        deliveryStatus: z.enum(['pending_notification_channel', 'delivered', 'dismissed']),
        createdAt: z.iso.datetime(),
      })
    ),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    hasNext: z.boolean(),
  }),
})

export type SecurityAlertsQuery = z.infer<typeof SecurityAlertsQuerySchema>
