import { DashboardAttentionSchema, OrgDashboardSchema } from '@project-vault/shared'
import { z } from 'zod/v4'

export const OrgDashboardResponseSchema = z
  .object({ data: OrgDashboardSchema })
  .meta({ id: 'OrgDashboardResponse' })

export const DashboardAttentionResponseSchema = z
  .object({ data: DashboardAttentionSchema })
  .meta({ id: 'DashboardAttentionResponse' })
