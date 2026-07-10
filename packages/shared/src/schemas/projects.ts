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
    // AC-P1: strictly additive — mirrors projects.tags's existing non-null jsonb-array default
    // (the PUT .../tags route already reads/writes this exact column; the list handler just
    // hadn't selected it yet).
    tags: z.array(z.string()),
    createdAt: z.iso.datetime(),
    // 4.4 AC-3: archivedAt is null for active projects; isArchived is derived in the handler
    // (archivedAt !== null), not stored. Both required — a contract change to ProjectSummary.
    archivedAt: z.iso.datetime().nullable(),
    isArchived: z.boolean(),
  })
  .meta({ id: 'ProjectSummary' })

/** 4.4 AC-8: minimal archive/unarchive route response representation. */
export const ProjectArchiveStateSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    archivedAt: z.iso.datetime().nullable(),
    isArchived: z.boolean(),
  })
  .meta({ id: 'ProjectArchiveState' })

export type ProjectArchiveState = z.infer<typeof ProjectArchiveStateSchema>

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
