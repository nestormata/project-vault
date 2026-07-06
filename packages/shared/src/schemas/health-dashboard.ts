import { z } from 'zod/v4'

// Story 6.3 (ADR-6.3-02, realigned): 'service' here always means a `service_endpoints` row
// (Story 6.2), never a `payment_records` row. 6.2's `status` column is a plain `text` + `CHECK`
// constraint, not a Drizzle pgEnum, so there is no reusable exported union type to import — this
// literal restates the same three values 6.2's CHECK constraint already enforces at the DB layer
// (packages/db/src/schema/service-endpoints.ts), which is acceptable duplication (same values, not
// diverging ones).
export const HealthDashboardServiceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: z.enum(['healthy', 'degraded', 'down']),
    lastCheckedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'HealthDashboardService' })

export const HealthDashboardProjectSchema = z
  .object({
    projectId: z.uuid(),
    projectName: z.string(),
    services: z.array(HealthDashboardServiceSchema),
  })
  .meta({ id: 'HealthDashboardProject' })

export const HealthDashboardSummarySchema = z
  .object({
    healthy: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    down: z.number().int().nonnegative(),
  })
  .meta({ id: 'HealthDashboardSummary' })

export const HealthDashboardSchema = z
  .object({
    projects: z.array(HealthDashboardProjectSchema),
    summary: HealthDashboardSummarySchema,
  })
  .meta({ id: 'HealthDashboard' })

export const HealthDashboardResponseSchema = z
  .object({ data: HealthDashboardSchema })
  .meta({ id: 'HealthDashboardResponse' })

export type HealthDashboardService = z.infer<typeof HealthDashboardServiceSchema>
export type HealthDashboardProject = z.infer<typeof HealthDashboardProjectSchema>
export type HealthDashboardSummary = z.infer<typeof HealthDashboardSummarySchema>
export type HealthDashboard = z.infer<typeof HealthDashboardSchema>
