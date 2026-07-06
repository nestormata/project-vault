import { z } from 'zod/v4'

// Story 6.3 AC 21 (Task 6): the admin-facing "current configuration" shape returned by
// GET /api/v1/projects/:projectId/status-page. Never includes the plaintext token (never
// persisted, AC 8) or tokenHash.
export const StatusPageConfigServiceSchema = z
  .object({
    serviceId: z.uuid(),
    displayName: z.string(),
    sortOrder: z.number().int(),
  })
  .meta({ id: 'StatusPageConfigService' })

export const StatusPageConfigSchema = z
  .object({
    enabled: z.boolean(),
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
    services: z.array(StatusPageConfigServiceSchema).optional(),
  })
  .meta({ id: 'StatusPageConfig' })

export const StatusPageConfigResponseSchema = z
  .object({ data: StatusPageConfigSchema })
  .meta({ id: 'StatusPageConfigResponse' })

// Story 6.3 AC 8/11: the one-time plaintext-token response shape shared by enable and regenerate.
export const StatusPageTokenSchema = z
  .object({
    token: z.string(),
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'StatusPageToken' })

export const StatusPageTokenResponseSchema = z
  .object({ data: StatusPageTokenSchema })
  .meta({ id: 'StatusPageTokenResponse' })

// Story 6.3 AC 12: the public, unauthenticated view — deliberately excludes serviceId, the
// underlying service_endpoints name/url, projectId, orgId, or any other internal identifier
// (FR77's core privacy guarantee).
export const PublicStatusPageServiceSchema = z
  .object({
    displayName: z.string(),
    status: z.enum(['healthy', 'degraded', 'down']),
    lastCheckedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PublicStatusPageService' })

export const PublicStatusPageSchema = z
  .object({
    services: z.array(PublicStatusPageServiceSchema),
  })
  .meta({ id: 'PublicStatusPage' })

export const PublicStatusPageResponseSchema = z
  .object({ data: PublicStatusPageSchema })
  .meta({ id: 'PublicStatusPageResponse' })

// Story 6.3 AC 15: the PUT response echoes the updated public-facing service list (with
// serviceId, unlike the public GET) so the admin UI can confirm what was saved.
export const StatusPageServiceSchema = z
  .object({
    serviceId: z.uuid(),
    displayName: z.string(),
    sortOrder: z.number().int(),
  })
  .meta({ id: 'StatusPageService' })

export const StatusPageServicesResponseSchema = z
  .object({ data: z.object({ services: z.array(StatusPageServiceSchema) }) })
  .meta({ id: 'StatusPageServicesResponse' })

export type StatusPageConfigService = z.infer<typeof StatusPageConfigServiceSchema>
export type StatusPageConfig = z.infer<typeof StatusPageConfigSchema>
export type StatusPageToken = z.infer<typeof StatusPageTokenSchema>
export type PublicStatusPageService = z.infer<typeof PublicStatusPageServiceSchema>
export type PublicStatusPage = z.infer<typeof PublicStatusPageSchema>
export type StatusPageService = z.infer<typeof StatusPageServiceSchema>
