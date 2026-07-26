import { z } from 'zod/v4'

// Shared account-password strength rule — reused by registration and by account recovery's
// password reset (Story 4.3 AC-14) so both entry points enforce identical bounds.
export const PasswordSchema = z.string().min(12).max(256)

export const RegisterRequestSchema = z
  .object({
    email: z.email().max(254),
    password: PasswordSchema,
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

// Story 14.4 AC-2a: deliberately NOT z.email() — the domain-lookup endpoint must not assume a
// validated email shape; a malformed/no-`@` value is "no mapping" (fail-open to the password
// field), not a 422. Server-side domain extraction (routes handler) treats any non-conforming
// value as "no domain" rather than rejecting the request.
export const DomainLookupRequestSchema = z
  .object({
    email: z.string().min(1).max(254),
  })
  .meta({ id: 'DomainLookupRequest' })

// Story 14.4 AC-9a/AC-9b: never the org's id or name — only whether the domain maps to SSO, and
// (if so) which provider. Structurally identical shape on hit vs. miss (providerName just absent
// on a miss, never a different key set).
export const DomainLookupResponseSchema = z
  .object({
    ssoRequired: z.boolean(),
    providerName: z.string().optional(),
  })
  .meta({ id: 'DomainLookupResponse' })

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>
export type LoginRequest = z.infer<typeof LoginRequestSchema>
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>
export type SessionSummary = z.infer<typeof SessionSummarySchema>
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponseSchema>
export type AdminRevokeSessionsResponse = z.infer<typeof AdminRevokeSessionsResponseSchema>
export type DomainLookupRequest = z.infer<typeof DomainLookupRequestSchema>
export type DomainLookupResponse = z.infer<typeof DomainLookupResponseSchema>
