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

// Story 14.6 AC-2: normalizes a caller-supplied domain the same way on every check — lowercase,
// then strip a single trailing FQDN dot (`gmail.com.` is a valid absolute hostname for
// `gmail.com` and must not bypass the public-domain blocklist via this variant). Reused by both
// the request schema (below, so the value that reaches the route handler is already normalized)
// and the service layer's own re-derivation for edit/conflict checks — normalize-on-write, per
// org-sso-domains.ts's schema comment convention.
export function normalizeSsoDomain(domain: string): string {
  const lower = domain.toLowerCase()
  return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

// Story 14.6 AC-2(b): a strict hostname-label format check — no `@`, no leading/trailing `.`
// (post-normalization), no wildcard `*`, no whitespace. Deliberately not a claimed-complete RFC
// 1035 validator — just enough to reject the obviously-malformed inputs this AC calls out.
const DOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

export function isValidDomainLabel(domain: string): boolean {
  if (domain.length === 0) return false
  if (domain.includes('@')) return false
  if (domain.includes('*')) return false
  if (/\s/.test(domain)) return false
  if (domain.startsWith('.') || domain.endsWith('.')) return false
  return DOMAIN_LABEL_PATTERN.test(domain)
}

// Story 14.6 AC-2/AC-3's error-code contract — imported by both the API route/service layer and
// the web client's typed error branches, so the literal strings live in exactly one place.
export const ORG_SSO_DOMAIN_ERROR_CODES = {
  INVALID_DOMAIN_FORMAT: 'invalid_domain_format',
  PUBLIC_DOMAIN_BLOCKED: 'public_domain_blocked',
  PROVIDER_NOT_REGISTERED: 'provider_not_registered',
  PROVIDER_CHECK_UNAVAILABLE: 'provider_check_unavailable',
  DOMAIN_ALREADY_MAPPED: 'domain_already_mapped',
} as const

export type OrgSsoDomainErrorCode =
  (typeof ORG_SSO_DOMAIN_ERROR_CODES)[keyof typeof ORG_SSO_DOMAIN_ERROR_CODES]

// Normalizes then format-checks — the transform runs before the refine, so normalization always
// precedes the format check (and, downstream in the service layer, the blocklist check) per AC-2.
const OrgSsoDomainFieldSchema = z
  .string()
  .min(1)
  .max(253)
  .transform((value) => normalizeSsoDomain(value))
  .refine((value) => isValidDomainLabel(value), { message: 'invalid_domain_format' })

const OrgSsoDomainProviderNameFieldSchema = z.string().min(1).max(128)

export const CreateOrgSsoDomainRequestSchema = z
  .object({
    domain: OrgSsoDomainFieldSchema,
    providerName: OrgSsoDomainProviderNameFieldSchema,
  })
  .strict()
  .meta({ id: 'CreateOrgSsoDomainRequest' })

export const UpdateOrgSsoDomainRequestSchema = z
  .object({
    domain: OrgSsoDomainFieldSchema.optional(),
    providerName: OrgSsoDomainProviderNameFieldSchema.optional(),
  })
  .strict()
  .refine((data) => data.domain !== undefined || data.providerName !== undefined, {
    message: 'At least one of domain or providerName must be provided',
    path: ['domain'],
  })
  .meta({ id: 'UpdateOrgSsoDomainRequest' })

// Deliberately no `.meta({ id: ... })` here — params schemas in this codebase (e.g.
// OrgUserParamsSchema in apps/api/src/modules/org/schema.ts) are never registered as named
// OpenAPI components; @fastify/swagger's $ref resolver cannot resolve a `.meta()`'d params schema.
export const OrgSsoDomainParamsSchema = z.object({ id: z.uuid() })

export const OrgSsoDomainResponseSchema = z
  .object({
    id: z.uuid(),
    domain: z.string(),
    providerName: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'OrgSsoDomainResponse' })

export const OrgSsoDomainListResponseSchema = z.array(OrgSsoDomainResponseSchema).meta({
  id: 'OrgSsoDomainListResponse',
})

// A dedicated schema (not `OrgSsoDomainResponseSchema.pick(...)`) — @fastify/swagger's OpenAPI
// $ref resolver cannot resolve a `.pick()`'d subset of an already-`.meta()`'d schema.
export const OrgSsoDomainDeletedResponseSchema = z.object({ id: z.uuid() }).meta({
  id: 'OrgSsoDomainDeletedResponse',
})

export type CreateOrgSsoDomainRequest = z.infer<typeof CreateOrgSsoDomainRequestSchema>
export type UpdateOrgSsoDomainRequest = z.infer<typeof UpdateOrgSsoDomainRequestSchema>
export type OrgSsoDomainParams = z.infer<typeof OrgSsoDomainParamsSchema>
export type OrgSsoDomainResponse = z.infer<typeof OrgSsoDomainResponseSchema>
export type OrgSsoDomainListResponse = z.infer<typeof OrgSsoDomainListResponseSchema>

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
