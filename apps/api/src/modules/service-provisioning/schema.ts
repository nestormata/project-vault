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
