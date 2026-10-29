import { z } from 'zod/v4'
import { archivableEntityAuditFields } from './audit-fields.js'

export const ProjectRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer'])

/** Story 72-9: caps for a project's reference links. */
export const PROJECT_URLS_MAX = 10
export const PROJECT_URL_MAX_LENGTH = 2048

function isAllowedProjectUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  // http/https only (never javascript:, data:, file:), and no embedded user:password.
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' &&
    parsed.password === ''
  )
}

/**
 * Story 72-9: the `urls` field of a project edit. Each entry is trimmed, at most 2048 characters,
 * an absolute http(s) URL without credentials; at most 10 entries, no case-insensitive duplicates.
 */
export const ProjectUrlsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(PROJECT_URL_MAX_LENGTH)
      .refine(isAllowedProjectUrl, 'Must be an absolute http or https URL without credentials')
  )
  .max(PROJECT_URLS_MAX)
  .refine(
    (urls) => new Set(urls.map((url) => url.toLowerCase())).size === urls.length,
    'URLs must be unique'
  )

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
    ...archivableEntityAuditFields,
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
  // Story 72-9: reference links (http/https), empty when none.
  urls: z.array(z.string()),
  memberCount: z.number().int().nonnegative(),
}).meta({ id: 'ProjectOverview' })

export type ProjectOverview = z.infer<typeof ProjectOverviewSchema>

/** Story 72-9: a soft-deleted project awaiting purge (the restore list). */
export const DeletedProjectSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    deletedAt: z.iso.datetime(),
    purgeAfter: z.iso.datetime(),
  })
  .meta({ id: 'DeletedProject' })

export type DeletedProject = z.infer<typeof DeletedProjectSchema>
