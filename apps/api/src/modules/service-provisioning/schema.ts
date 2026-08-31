import { z } from 'zod/v4'

/**
 * Story 26.1 AC-6: requestId is the idempotency key (organizations.service_provisioning_request_id,
 * migration 0083) — not organizationName/workosUserId. organizationName/workosUserId are
 * plain non-empty strings; the org's slug is server-derived (allocateOrganizationSlug reuse),
 * never accepted from the caller.
 */
export const ProvisionServiceOrganizationRequestSchema = z.object({
  requestId: z.uuid(),
  organizationName: z.string().trim().min(1).max(255),
  workosUserId: z.string().trim().min(1).max(256),
  // Story 30.2 (org-mismatch critical-bug fix): CM's own organizationId (WorkOS-directory-shaped,
  // e.g. "org_synthetic_acme") — stored on organizations.centralizeme_organization_id and later
  // compared against a handoff token's `organizationId` claim (see auth/handoff-routes.ts's
  // burnAndResolveOrg). Optional because CM's provisioning client does not send it yet (deferred
  // follow-up — see deferred-work.md); this must stay backward compatible with CM's current,
  // unmodified caller.
  centralizemeOrganizationId: z.string().trim().min(1).max(256).optional(),
})

export type ProvisionServiceOrganizationRequest = z.infer<
  typeof ProvisionServiceOrganizationRequestSchema
>

export const ProvisionServiceOrganizationResponseSchema = z.object({
  data: z.object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    externalIdentityId: z.uuid(),
  }),
})

export type ProvisionServiceOrganizationResponse = z.infer<
  typeof ProvisionServiceOrganizationResponseSchema
>

/**
 * Story 31.1 (DW-130) AC3.13: the URL's :centralizemeOrganizationId param — a CM
 * WorkOS-directory-shaped string, never a PV UUID. Mirrors
 * ProvisionServiceOrganizationRequestSchema's own centralizemeOrganizationId field constraints
 * exactly (trim, min 1, max 256), validated before any DB query runs.
 */
export const RevokeOrgSessionsParamsSchema = z.object({
  centralizemeOrganizationId: z.string().trim().min(1).max(256),
})

export type RevokeOrgSessionsParams = z.infer<typeof RevokeOrgSessionsParamsSchema>

/**
 * Story 31.1 AC1.1/AC5.19: requestId is the caller's own idempotency/correlation key (echoed
 * back in the response and the audit payload) — NOT organizations.service_provisioning_request_id
 * (that column is Story 26.1's, for a different route). Deliberately no `orgId` field anywhere in
 * this schema: the target org is resolved exclusively from the URL param (AC3), and a caller-
 * supplied org hint could otherwise widen scope (claim contract threat 6) — `.strict()` rejects
 * an unknown `orgId` (or any other extra) field with 422 rather than silently ignoring it.
 */
export const RevokeOrgSessionsRequestSchema = z
  .object({
    requestId: z.uuid(),
  })
  .strict()

export type RevokeOrgSessionsRequest = z.infer<typeof RevokeOrgSessionsRequestSchema>

export const RevokeOrgSessionsResponseSchema = z.object({
  data: z.object({
    organizationId: z.uuid(),
    sessionsRevokedCount: z.number().int().nonnegative(),
    apiKeysRevokedCount: z.number().int().nonnegative(),
    requestId: z.uuid(),
  }),
})

export type RevokeOrgSessionsResponse = z.infer<typeof RevokeOrgSessionsResponseSchema>
