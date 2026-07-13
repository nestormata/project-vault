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

// 12-1 AC-1/AC-2: the project overview page needs the project's tags (ProjectDetail omits them —
// used by create/update responses that never render tags) and a member count (AC-2's "member
// count" tile — no existing viewer-accessible endpoint returns this: GET /:projectId/members is
// project-admin/owner-or-org-admin/owner-gated, so a viewer role would 403 fetching it directly).
// Extending ProjectDetail here (additive, new schema) rather than changing ProjectDetailSchema
// itself, which create/update-project responses already depend on.
export const ProjectOverviewSchema = ProjectDetailSchema.extend({
  tags: z.array(z.string()),
  memberCount: z.number().int().nonnegative(),
}).meta({ id: 'ProjectOverview' })

export type ProjectOverview = z.infer<typeof ProjectOverviewSchema>
