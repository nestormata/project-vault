import { z } from 'zod/v4'
import { ProjectScopeParamsSchema } from '../credentials/schema.js'
import { paginatedListMetaFields } from '../../lib/api-contracts.js'

export { ProjectScopeParamsSchema }

// AC 7/17: shared page-based pagination query fields (mirrors SecurityAlertsQuerySchema's
// convention) — used by both HealthHistoryQuerySchema and AlertListQuerySchema below.
const pageBasedPaginationQueryFields = {
  limit: z.coerce.number().int().positive().max(200).default(50),
  page: z.coerce.number().int().min(1).default(1),
}

// Arbitrary reasonable cap (not specified numerically in epics.md/architecture.md) bounding
// worst-case daily-job iteration per asset — see Dev Notes in the 6.1 story file.
export const MAX_ALERT_LEAD_DAYS = 10

const alertLeadDaysSchema = z.array(z.number().int().positive()).max(MAX_ALERT_LEAD_DAYS)

// Shared field groups — see AC 6 note on each Create/Update body schema: url/renewalDate/
// alertLeadDays (services & domains) or the equivalent expiresAt+alertLeadDays shape (certs)
// are identical across the update-body variants, and every *RecordSchema shares the same
// identity/audit tail fields. Spreading these avoids re-typing the same field list 3x, which
// otherwise trips the repo's zero-duplication jscpd gate (see 6.1 code-review notes).
const recordIdentityFields = { id: z.uuid(), orgId: z.uuid(), projectId: z.uuid() }
const recordAuditTailFields = {
  alertLeadDays: z.array(z.number()),
  notifiedLeadDays: z.array(z.number()),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}

export const ServiceParamsSchema = z
  .object({ projectId: z.uuid(), serviceId: z.uuid() })
  .meta({ id: 'ServiceParams' })
export const CertificateParamsSchema = z
  .object({ projectId: z.uuid(), certificateId: z.uuid() })
  .meta({ id: 'CertificateParams' })
export const DomainRecordParamsSchema = z
  .object({ projectId: z.uuid(), domainId: z.uuid() })
  .meta({ id: 'DomainRecordParams' })

// --- Services (payment_records) — FR24 ---

const paymentRenewalFields = {
  url: z.string().trim().min(1).max(2048).nullable().optional(),
  renewalDate: z.iso.datetime().nullable().optional(),
  alertLeadDays: alertLeadDaysSchema.optional(),
}

export const CreatePaymentRecordBodySchema = z
  .object({ name: z.string().trim().min(1).max(256), ...paymentRenewalFields })
  .strict()
  .meta({ id: 'CreatePaymentRecordBody' })

export const UpdatePaymentRecordBodySchema = z
  .object(paymentRenewalFields)
  .strict()
  .meta({ id: 'UpdatePaymentRecordBody' })

export const PaymentRecordSchema = z
  .object({
    ...recordIdentityFields,
    name: z.string(),
    url: z.string().nullable(),
    renewalDate: z.iso.datetime().nullable(),
    ...recordAuditTailFields,
  })
  .meta({ id: 'PaymentRecord' })

export const PaymentRecordResponseSchema = z
  .object({ data: PaymentRecordSchema })
  .meta({ id: 'PaymentRecordResponse' })
export const PaymentRecordListResponseSchema = z
  .object({ data: z.object({ items: z.array(PaymentRecordSchema) }) })
  .meta({ id: 'PaymentRecordListResponse' })

// --- Certificates (cert_records) — FR25 ---

export const CreateCertificateBodySchema = z
  .object({
    domain: z.string().trim().min(1).max(253),
    expiresAt: z.iso.datetime(),
    alertLeadDays: alertLeadDaysSchema.optional(),
  })
  .strict()
  .meta({ id: 'CreateCertificateBody' })

export const UpdateCertificateBodySchema = z
  .object({
    domain: z.string().trim().min(1).max(253).optional(),
    expiresAt: z.iso.datetime().optional(),
    alertLeadDays: alertLeadDaysSchema.optional(),
  })
  .strict()
  .meta({ id: 'UpdateCertificateBody' })

export const CertificateRecordSchema = z
  .object({
    ...recordIdentityFields,
    domain: z.string(),
    expiresAt: z.iso.datetime().nullable(),
    ...recordAuditTailFields,
  })
  .meta({ id: 'CertificateRecord' })

export const CertificateRecordResponseSchema = z
  .object({ data: CertificateRecordSchema })
  .meta({ id: 'CertificateRecordResponse' })
export const CertificateRecordListResponseSchema = z
  .object({ data: z.object({ items: z.array(CertificateRecordSchema) }) })
  .meta({ id: 'CertificateRecordListResponse' })

// --- Domains (domain_records) — FR26 ---

export const CreateDomainRecordBodySchema = z
  .object({
    domainName: z.string().trim().min(1).max(253),
    renewalDate: z.iso.datetime(),
    alertLeadDays: alertLeadDaysSchema.optional(),
  })
  .strict()
  .meta({ id: 'CreateDomainRecordBody' })

export const UpdateDomainRecordBodySchema = z
  .object({
    domainName: z.string().trim().min(1).max(253).optional(),
    renewalDate: z.iso.datetime().optional(),
    alertLeadDays: alertLeadDaysSchema.optional(),
  })
  .strict()
  .meta({ id: 'UpdateDomainRecordBody' })

export const DomainRecordSchema = z
  .object({
    ...recordIdentityFields,
    domainName: z.string(),
    renewalDate: z.iso.datetime().nullable(),
    ...recordAuditTailFields,
  })
  .meta({ id: 'DomainRecord' })

export const DomainRecordResponseSchema = z
  .object({ data: DomainRecordSchema })
  .meta({ id: 'DomainRecordResponse' })
export const DomainRecordListResponseSchema = z
  .object({ data: z.object({ items: z.array(DomainRecordSchema) }) })
  .meta({ id: 'DomainRecordListResponse' })

// --- Service endpoints (service_endpoints) — Story 6.2, ADR-6.2-01 ---

export const ServiceEndpointParamsSchema = z
  .object({ projectId: z.uuid(), serviceEndpointId: z.uuid() })
  .meta({ id: 'ServiceEndpointParams' })

const CHECK_FREQUENCY_MINUTES = [1, 5, 15, 30] as const

const serviceEndpointWriteFields = {
  name: z.string().trim().min(1).max(256),
  url: z.string().trim().min(1).max(2048),
  checkFrequencyMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30)]),
  downThresholdFailures: z.number().int().min(1).max(10),
}

export const CreateServiceEndpointBodySchema = z
  .object({
    name: serviceEndpointWriteFields.name,
    url: serviceEndpointWriteFields.url,
    checkFrequencyMinutes: serviceEndpointWriteFields.checkFrequencyMinutes.optional(),
    downThresholdFailures: serviceEndpointWriteFields.downThresholdFailures.optional(),
  })
  .strict()
  .meta({ id: 'CreateServiceEndpointBody' })

export const UpdateServiceEndpointBodySchema = z
  .object({
    name: serviceEndpointWriteFields.name.optional(),
    url: serviceEndpointWriteFields.url.optional(),
    checkFrequencyMinutes: serviceEndpointWriteFields.checkFrequencyMinutes.optional(),
    downThresholdFailures: serviceEndpointWriteFields.downThresholdFailures.optional(),
  })
  .strict()
  .meta({ id: 'UpdateServiceEndpointBody' })

// downEpisodeStartedAt is deliberately excluded (adversarial-review finding 23) — internal
// bookkeeping only, never part of the public API contract.
export const ServiceEndpointSchema = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    projectId: z.uuid(),
    name: z.string(),
    url: z.string(),
    checkFrequencyMinutes: z.number().int(),
    downThresholdFailures: z.number().int(),
    status: z.enum(['healthy', 'degraded', 'down']),
    consecutiveFailures: z.number().int(),
    lastCheckedAt: z.iso.datetime().nullable(),
    createdBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ServiceEndpoint' })

export const ServiceEndpointResponseSchema = z
  .object({ data: ServiceEndpointSchema })
  .meta({ id: 'ServiceEndpointResponse' })
export const ServiceEndpointListResponseSchema = z
  .object({ data: z.object({ items: z.array(ServiceEndpointSchema) }) })
  .meta({ id: 'ServiceEndpointListResponse' })

// --- Health history (endpoint_health_checks) — AC 7 ---

export const HealthHistoryQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  // Explicit default (adversarial-review finding 21) rather than relying on undefined handling.
  ...pageBasedPaginationQueryFields,
})
export type HealthHistoryQuery = z.infer<typeof HealthHistoryQuerySchema>

export const HealthHistoryEntrySchema = z
  .object({
    isHealthy: z.boolean(),
    statusCode: z.number().int().nullable(),
    latencyMs: z.number().int(),
    failureReason: z.enum(['timeout', 'http_error', 'network_error', 'ssrf_blocked']).nullable(),
    checkedAt: z.iso.datetime(),
  })
  .meta({ id: 'HealthHistoryEntry' })

export const HealthHistoryResponseSchema = z
  .object({
    data: z.object({
      items: z.array(HealthHistoryEntrySchema),
      ...paginatedListMetaFields,
    }),
  })
  .meta({ id: 'HealthHistoryResponse' })

// --- Monitoring alerts (monitoring_alerts) — AC 9, 10, 17 ---

export const AlertParamsSchema = z
  .object({ projectId: z.uuid(), alertId: z.uuid() })
  .meta({ id: 'AlertParams' })

export const SnoozeAlertBodySchema = z
  .object({ durationMinutes: z.number().int().positive().max(10_080) })
  .strict()
  .meta({ id: 'SnoozeAlertBody' })
export type SnoozeAlertBody = z.infer<typeof SnoozeAlertBodySchema>

export const MonitoringAlertStatusSchema = z.enum([
  'active',
  'snoozed',
  'dismissed',
  'resolved_by_deletion',
])

// AC 17: page-based pagination (mirrors AC 7's convention and SecurityAlertsQuerySchema); the
// literal `cursor=` in epics.md's URL example is prose imprecision from the now-superseded
// unified-assetId model — `page` is the real, already-established pagination mechanism.
export const AlertListQuerySchema = z.object({
  status: MonitoringAlertStatusSchema.optional(),
  serviceEndpointId: z.uuid().optional(),
  ...pageBasedPaginationQueryFields,
})
export type AlertListQuery = z.infer<typeof AlertListQuerySchema>

export const MonitoringAlertSchema = z
  .object({
    id: z.uuid(),
    alertType: z.enum(['service.down', 'service.recovery']),
    severity: z.enum(['info', 'warning', 'critical']),
    status: MonitoringAlertStatusSchema,
    episodeKey: z.string(),
    // Nullable: ON DELETE SET NULL on the underlying FK (see monitoring-alerts.ts) — an alert
    // whose service_endpoints row was later deleted survives as a historical record with this
    // field cleared, rather than being cascade-deleted itself.
    serviceEndpointId: z.uuid().nullable(),
    snoozedUntil: z.iso.datetime().nullable(),
    dismissedBy: z.uuid().nullable(),
    dismissedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'MonitoringAlert' })

export const MonitoringAlertResponseSchema = z
  .object({ data: MonitoringAlertSchema })
  .meta({ id: 'MonitoringAlertResponse' })

export const AlertListResponseSchema = z
  .object({
    data: z.object({
      items: z.array(MonitoringAlertSchema),
      ...paginatedListMetaFields,
    }),
  })
  .meta({ id: 'AlertListResponse' })

export type CreatePaymentRecordBody = z.infer<typeof CreatePaymentRecordBodySchema>
export type UpdatePaymentRecordBody = z.infer<typeof UpdatePaymentRecordBodySchema>
export type CreateCertificateBody = z.infer<typeof CreateCertificateBodySchema>
export type UpdateCertificateBody = z.infer<typeof UpdateCertificateBodySchema>
export type CreateDomainRecordBody = z.infer<typeof CreateDomainRecordBodySchema>
export type UpdateDomainRecordBody = z.infer<typeof UpdateDomainRecordBodySchema>
export type ServiceParams = z.infer<typeof ServiceParamsSchema>
export type CertificateParams = z.infer<typeof CertificateParamsSchema>
export type DomainRecordParams = z.infer<typeof DomainRecordParamsSchema>
export type CreateServiceEndpointBody = z.infer<typeof CreateServiceEndpointBodySchema>
export type UpdateServiceEndpointBody = z.infer<typeof UpdateServiceEndpointBodySchema>
export type ServiceEndpointParams = z.infer<typeof ServiceEndpointParamsSchema>
export type AlertParams = z.infer<typeof AlertParamsSchema>

// CHECK_FREQUENCY_MINUTES retained for reference/tests; the union literal schema above enforces
// the same [1,5,15,30] domain declaratively.
export { CHECK_FREQUENCY_MINUTES }

// --- Status pages (status_pages/status_page_services) — Story 6.3 ---
// Request-body schemas stay module-local (Dev Notes: 6.1 already established this exception to
// architecture.md's general "import from packages/shared" guidance for request bodies). Response
// types the web app must consume live in packages/shared/src/schemas/status-page.ts instead.

export const StatusPageProjectParamsSchema = z
  .object({ projectId: z.uuid() })
  .meta({ id: 'StatusPageProjectParams' })

// AC 15: arbitrary reasonable cap (undocumented in epics.md/architecture.md, same style of
// documented-but-unsourced bound as 6.1's alertLeadDays max-10 cap) bounding public-page
// rendering size.
export const MAX_STATUS_PAGE_SERVICES = 50

const statusPageServiceInputSchema = z.object({
  serviceId: z.uuid(),
  // AC 15 (realignment-review finding): trim before length-checking so a whitespace-only name
  // can't slip through as a non-empty string and silently render as a blank public label.
  displayName: z.string().trim().min(1).max(100),
})

export const UpdateStatusPageBodySchema = z
  .object({
    services: z
      .array(statusPageServiceInputSchema)
      .max(MAX_STATUS_PAGE_SERVICES)
      .refine((services) => new Set(services.map((s) => s.serviceId)).size === services.length, {
        message: 'Duplicate serviceId in request',
      }),
  })
  .strict()
  .meta({ id: 'UpdateStatusPageBody' })

export type UpdateStatusPageBody = z.infer<typeof UpdateStatusPageBodySchema>
export type StatusPageProjectParams = z.infer<typeof StatusPageProjectParamsSchema>

export const StatusPageTokenParamsSchema = z
  .object({ token: z.string().min(1) })
  .meta({ id: 'StatusPageTokenParams' })
export type StatusPageTokenParams = z.infer<typeof StatusPageTokenParamsSchema>
