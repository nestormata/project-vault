import { z } from 'zod/v4'
import { passwordMeetsStrengthRequirement } from './password-strength.js'

// Shared account-password strength rule — reused by registration and by account recovery's
// password reset (Story 4.3 AC-14) so both entry points enforce identical bounds. Story 1.21
// AC-1: the length floor alone accepted length-padded-but-trivially-guessable passwords (e.g.
// `passwordpassword`) — the `.refine()` adds an offline zxcvbn-ts strength estimate on top of
// the existing length bound. Deliberately NOT applied to `LoginRequestSchema.password` or
// `mfaRecoverBodySchema.password` (apps/api/src/modules/auth/schema.ts) — both verify an
// *existing* credential rather than mint a new one, so strength-checking them would reject
// legitimate users for a weakness they cannot fix mid-login/mid-recovery.
export const PasswordSchema = z
  .string()
  .min(12)
  .max(256)
  .refine(passwordMeetsStrengthRequirement, 'password_too_weak')

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
    // Story 16.4 AC-3: present only on a successful resolution of a currently-valid org default
    // theme for a domain that maps to an org via `org_sso_domains` — `null`/absent on every other
    // path (no mapping, no/orphaned org default, DB error). Both-or-neither invariant (Red Team,
    // Round 2): `name` and `css` are never independently present.
    theme: z
      .object({
        name: z.string(),
        css: z.string(),
      })
      .nullable()
      .optional(),
  })
  .meta({ id: 'DomainLookupResponse' })

// Story 14.6's normalizeSsoDomain/isValidDomainLabel/ORG_SSO_DOMAIN_ERROR_CODES and the
// Create/Update/List/Delete OrgSsoDomain schemas moved to `org-sso-domains.ts` in Story 1.21
// (AC-3 bundle-isolation split — see that file's header comment).

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
