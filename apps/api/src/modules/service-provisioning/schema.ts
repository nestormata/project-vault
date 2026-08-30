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
