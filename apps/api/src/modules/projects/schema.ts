import {
  ProjectArchiveStateSchema,
  ProjectDashboardSchema,
  ProjectDetailSchema,
  ProjectSummarySchema,
  type ProjectDetail,
  type ProjectSummary,
} from '@project-vault/shared'
import { z } from 'zod/v4'
export { TagArrayBodySchema } from '../credentials/schema.js'

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$|^[a-z0-9]{3}$/

export const CreateProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    slug: z
      .string()
      .regex(SLUG_REGEX, 'Slug must be 3-50 lowercase alphanumeric characters and hyphens'),
    description: z.string().max(512).trim().nullable().optional(),
  })
  .strict()
  .meta({ id: 'CreateProjectBody' })

export const PatchProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(512).trim().nullable().optional(),
    slug: z.string().optional(),
  })
  .strict()
  .transform(({ slug: _slug, ...body }) => body)
  .meta({ id: 'PatchProjectBody' })

export const ProjectParamsSchema = z.object({ projectId: z.uuid() }).meta({ id: 'ProjectParams' })

export const ProjectCreateResponseSchema = z
  .object({ data: ProjectDetailSchema })
  .meta({ id: 'ProjectCreateResponse' })

export const ProjectListResponseSchema = z
  .object({
    data: z.object({
      items: z.array(ProjectSummarySchema),
      total: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'ProjectListResponse' })

export const ProjectDashboardResponseSchema = z
  .object({ data: ProjectDashboardSchema })
  .meta({ id: 'ProjectDashboardResponse' })

export const PatchProjectResponseSchema = z
  .object({
    data: z.object({
      id: z.uuid(),
      name: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      updatedAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'PatchProjectResponse' })

export const ProjectTagUpdateResponseSchema = z
  .object({ data: z.object({ id: z.uuid(), tags: z.array(z.string()) }) })
  .meta({ id: 'ProjectTagUpdateResponse' })

export const ProjectMemberParamsSchema = z
  .object({ projectId: z.uuid(), userId: z.uuid() })
  .meta({ id: 'ProjectMemberParams' })

// 4.4 AC-8: archive/unarchive routes.
export const ArchiveResponseSchema = z
  .object({ data: ProjectArchiveStateSchema })
  .meta({ id: 'ArchiveResponse' })

// 4.4 AC-4/ADR-4.4-04: active-rotation 409 body — matches Story 4.3's shape verbatim
// (`error`, not `code`; carries `rotationIds`) for byte-compatible client handling.
export const ActiveRotationsErrorSchema = z
  .object({ error: z.literal('active_rotations'), rotationIds: z.array(z.uuid()) })
  .meta({ id: 'ActiveRotationsError' })

// 4.4 AC-3: `?includeArchived=true` on GET /api/v1/projects.
export const ListProjectsQuerySchema = z
  .object({
    // Do NOT use z.coerce.boolean() — it treats the string "false" as truthy.
    includeArchived: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .meta({ id: 'ListProjectsQuery' })

export const TransferOwnershipBodySchema = z
  .object({ newOwnerId: z.uuid() })
  .strict()
  .meta({ id: 'TransferOwnershipBody' })

const projectMemberRoleEnum = z.enum(['owner', 'admin', 'member', 'viewer'])

export const ProjectMembersListResponseSchema = z
  .object({
    data: z.array(
      z.object({
        userId: z.uuid(),
        email: z.string(),
        displayName: z.string(),
        role: projectMemberRoleEnum,
      })
    ),
  })
  .meta({ id: 'ProjectMembersListResponse' })

export const TransferOwnershipResponseSchema = z
  .object({
    data: z.object({
      projectId: z.uuid(),
      previousOwnerId: z.uuid(),
      newOwnerId: z.uuid(),
    }),
  })
  .meta({ id: 'TransferOwnershipResponse' })

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>
export type PatchProjectBody = z.infer<typeof PatchProjectBodySchema>
export type ProjectParams = z.infer<typeof ProjectParamsSchema>
export type ProjectMemberParams = z.infer<typeof ProjectMemberParamsSchema>
export type TransferOwnershipBody = z.infer<typeof TransferOwnershipBodySchema>
export type { ProjectDetail, ProjectSummary }
