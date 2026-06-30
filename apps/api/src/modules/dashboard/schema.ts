import { OrgDashboardSchema } from '@project-vault/shared'
import { z } from 'zod/v4'

export const OrgDashboardResponseSchema = z
  .object({ data: OrgDashboardSchema })
  .meta({ id: 'OrgDashboardResponse' })
