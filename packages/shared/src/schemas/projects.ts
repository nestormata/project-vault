import { z } from 'zod/v4'

export const ProjectRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer'])

export const ProjectSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    role: ProjectRoleSchema,
    credentialCount: z.number().int().nonnegative(),
    expiringCount: z.number().int().nonnegative(),
    alertCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ProjectSummary' })

export const ProjectDetailSchema = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    role: ProjectRoleSchema,
    createdBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ProjectDetail' })

export type ProjectRole = z.infer<typeof ProjectRoleSchema>
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>
