import { z } from 'zod/v4'

export const AuditVerifyQuerySchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .meta({ id: 'AuditVerifyQuery' })

export type AuditVerifyQuery = z.infer<typeof AuditVerifyQuerySchema>

export const AuditVerifyResponseSchema = z
  .object({
    data: z.object({
      summary: z.string(),
      rowsChecked: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.array(
        z.object({
          id: z.uuid(),
          eventType: z.string(),
          timestamp: z.iso.datetime(),
        })
      ),
      failedCount: z.number().int().nonnegative(),
      failedTruncated: z.boolean(),
      verifiedAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'AuditVerifyResponse' })

export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponseSchema>
