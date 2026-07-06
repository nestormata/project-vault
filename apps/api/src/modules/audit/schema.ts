import { z } from 'zod/v4'
import { PageLimitQueryShape } from '../../lib/pagination.js'
import { AUDIT_RETENTION_MIN_DAYS, AUDIT_RETENTION_MAX_DAYS } from './retention.js'

export const AuditVerifyQuerySchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .meta({ id: 'AuditVerifyQuery' })

export type AuditVerifyQuery = z.infer<typeof AuditVerifyQuerySchema>

export const AuditExportJobParamsSchema = z
  .object({ jobId: z.uuid() })
  .meta({ id: 'AuditExportJobParams' })

export type AuditExportJobParams = z.infer<typeof AuditExportJobParamsSchema>

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

// --- Story 8.2: search --------------------------------------------------------------------

export const AuditEventsQuerySchema = z
  .object({
    actorId: z.uuid().optional(),
    eventType: z.string().min(1).optional(),
    resourceId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    ...PageLimitQueryShape,
  })
  .meta({ id: 'AuditEventsQuery' })

export type AuditEventsQuery = z.infer<typeof AuditEventsQuerySchema>

export const AuditEventsResponseSchema = z
  .object({
    data: z.array(
      z.object({
        id: z.uuid(),
        eventType: z.string(),
        actorDisplayName: z.string(),
        resourceId: z.uuid().nullable(),
        resourceType: z.string().nullable(),
        projectId: z.uuid().nullable(),
        ipAddress: z.string().nullable(),
        createdAt: z.iso.datetime(),
      })
    ),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().nonnegative(),
    hasNext: z.boolean(),
  })
  .meta({ id: 'AuditEventsResponse' })

export type AuditEventsResponse = z.infer<typeof AuditEventsResponseSchema>

// --- Story 8.2: export ---------------------------------------------------------------------

export const AuditExportRequestSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    format: z.literal('csv'),
    includeIntegrityReport: z.boolean().default(true),
  })
  .meta({ id: 'AuditExportRequest' })

export type AuditExportRequest = z.infer<typeof AuditExportRequestSchema>

export const AuditExportTriggerResponseSchema = z
  .object({
    data: z.object({
      jobId: z.uuid(),
      status: z.literal('pending'),
    }),
  })
  .meta({ id: 'AuditExportTriggerResponse' })

export const AuditExportStatusResponseSchema = z
  .object({
    data: z.object({
      jobId: z.uuid(),
      status: z.enum(['pending', 'processing', 'completed', 'failed']),
      errorReason: z.string().nullable().optional(),
      rowsChecked: z.number().int().nonnegative().nullable().optional(),
      integritySummary: z
        .object({
          passed: z.number().int().nonnegative(),
          failedCount: z.number().int().nonnegative(),
          failed: z.array(z.unknown()).optional(),
        })
        .nullable()
        .optional(),
      downloadUrl: z.string().nullable(),
      createdAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
    }),
  })
  .meta({ id: 'AuditExportStatusResponse' })

// --- Story 8.2: forwarding -------------------------------------------------------------------

export const AuditForwardingConfigRequestSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('webhook'),
      config: z.object({
        url: z.url().startsWith('https://', { message: 'url must use https://' }),
        secretHeader: z.string().min(1),
      }),
    }),
    z.object({
      type: z.literal('s3'),
      config: z.object({
        bucket: z.string().min(1),
        prefix: z.string().optional(),
        region: z.string().min(1),
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
        endpoint: z
          .url()
          .startsWith('https://', { message: 'endpoint must use https://' })
          .optional(),
      }),
    }),
  ])
  .meta({ id: 'AuditForwardingConfigRequest' })

export type AuditForwardingConfigRequest = z.infer<typeof AuditForwardingConfigRequestSchema>

export const AuditForwardingConfigResponseSchema = z
  .object({
    data: z.object({
      type: z.enum(['webhook', 's3']),
      enabled: z.boolean(),
      configuredAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'AuditForwardingConfigResponse' })

// --- Story 8.2: retention --------------------------------------------------------------------

export const AuditRetentionConfigRequestSchema = z
  .object({
    // D7 — retentionDays: null is a valid, explicit "retain forever" state; only non-null values
    // are bounds-checked (Zod's min/max don't apply to null on a .nullable() number schema).
    retentionDays: z
      .number()
      .int()
      .min(AUDIT_RETENTION_MIN_DAYS, { message: `must be >= ${AUDIT_RETENTION_MIN_DAYS}` })
      .max(AUDIT_RETENTION_MAX_DAYS, { message: `must be <= ${AUDIT_RETENTION_MAX_DAYS}` })
      .nullable(),
  })
  .meta({ id: 'AuditRetentionConfigRequest' })

export type AuditRetentionConfigRequest = z.infer<typeof AuditRetentionConfigRequestSchema>

export const AuditRetentionConfigResponseSchema = z
  .object({
    data: z.object({
      retentionDays: z.number().int().nullable(),
      updatedAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'AuditRetentionConfigResponse' })
