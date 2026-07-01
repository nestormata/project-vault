import { z } from 'zod/v4'

export const RegisterRequestSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(12).max(256),
    orgName: z.string().min(1).max(128).trim().optional(),
    invitationToken: z.string().min(1).max(512).optional(),
  })
  .refine((data) => data.orgName || data.invitationToken, {
    message: 'orgName is required unless an invitationToken is provided',
    path: ['orgName'],
  })
  .meta({ id: 'RegisterRequest' })

export const LoginRequestSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(256),
  })
  .meta({ id: 'LoginRequest' })

export const AuthSessionResponseSchema = z
  .object({
    userId: z.uuid(),
    orgId: z.uuid(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'AuthSessionResponse' })

export const RegisterResponseSchema = z
  .object({
    userId: z.uuid(),
    orgId: z.uuid(),
    email: z.email(),
    orgName: z.string(),
    role: z.enum(['owner', 'member']),
    invitedProject: z
      .object({
        projectId: z.uuid(),
        projectName: z.string(),
        role: z.enum(['admin', 'member', 'viewer']),
      })
      .optional(),
  })
  .meta({ id: 'RegisterResponse' })

export const SessionSummarySchema = z
  .object({
    sessionId: z.uuid(),
    createdAt: z.iso.datetime(),
    lastActiveAt: z.iso.datetime(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    isCurrent: z.boolean(),
  })
  .meta({ id: 'SessionSummary' })

export const SessionListResponseSchema = z.array(SessionSummarySchema).meta({
  id: 'SessionListResponse',
})

export const RevokeSessionsResponseSchema = z
  .object({
    revokedCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'RevokeSessionsResponse' })

export const AdminRevokeSessionsResponseSchema = RevokeSessionsResponseSchema.extend({
  userId: z.uuid(),
}).meta({ id: 'AdminRevokeSessionsResponse' })

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>
export type LoginRequest = z.infer<typeof LoginRequestSchema>
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>
export type SessionSummary = z.infer<typeof SessionSummarySchema>
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponseSchema>
export type AdminRevokeSessionsResponse = z.infer<typeof AdminRevokeSessionsResponseSchema>
