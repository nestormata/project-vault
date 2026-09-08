import { z } from 'zod/v4'

// Story 1.21 AC-3: split out of auth.ts (which now imports password-strength.ts for
// PasswordSchema's zxcvbn refine) so that apps/web's sso-domains settings page — which imports
// ORG_SSO_DOMAIN_ERROR_CODES as a runtime value — never forces auth.ts's module graph (and
// therefore the zxcvbn dictionaries) into the browser bundle. Any single runtime export shared
// with `PasswordSchema` in one file would force this file's evaluation wherever that export is
// imported, `sideEffects: false` notwithstanding (that flag lets a bundler drop an entire *unused*
// module, but cannot partially evaluate one that is reachable). Purely a physical-file split, no
// behavior change — see auth.ts's own comment for the original Story 14.6 authorship context.

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
