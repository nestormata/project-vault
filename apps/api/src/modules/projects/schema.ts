import {
  ProjectDashboardSchema,
  ProjectDetailSchema,
  ProjectSummarySchema,
  type ProjectDetail,
  type ProjectSummary,
} from '@project-vault/shared'
import { z } from 'zod/v4'

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

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>
export type PatchProjectBody = z.infer<typeof PatchProjectBodySchema>
export type ProjectParams = z.infer<typeof ProjectParamsSchema>
export type { ProjectDetail, ProjectSummary }
