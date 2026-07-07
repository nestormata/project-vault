import { z } from 'zod/v4'
import { paginatedListMetaFields } from '../../lib/api-contracts.js'

// D2 item 1 (finding-8's resolution): the fast/historical branch is determined ONLY by whether
// `asOf` is present in the request body — never by comparing a supplied value to "now". `asOf`
// is therefore `.optional()` here, not defaulted — its mere presence-or-absence is the signal.
export const AccessReportRequestSchema = z
  .object({
    asOf: z.iso.datetime().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict()
  .meta({ id: 'AccessReportRequest' })

export type AccessReportRequest = z.infer<typeof AccessReportRequestSchema>

const orgProjectRoleEnum = z.enum(['owner', 'admin', 'member', 'viewer'])

export const AccessReportProjectSchema = z.object({
  projectId: z.uuid(),
  projectName: z.string(),
  role: orgProjectRoleEnum,
  grantedAt: z.iso.datetime(),
})

export const AccessReportUserSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  orgRole: orgProjectRoleEnum,
  status: z.enum(['active', 'deactivated']),
  projects: z.array(AccessReportProjectSchema),
})

export const AccessReportResponseSchema = z
  .object({
    data: z.object({
      users: z.array(AccessReportUserSchema),
      generatedAt: z.iso.datetime(),
      asOf: z.iso.datetime(),
      ...paginatedListMetaFields,
    }),
  })
  .meta({ id: 'AccessReportResponse' })

export type AccessReportUser = z.infer<typeof AccessReportUserSchema>
