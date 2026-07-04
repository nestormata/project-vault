import { z } from 'zod/v4'
import { ProjectScopeParamsSchema } from '../credentials/schema.js'

export { ProjectScopeParamsSchema }

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

export type CreatePaymentRecordBody = z.infer<typeof CreatePaymentRecordBodySchema>
export type UpdatePaymentRecordBody = z.infer<typeof UpdatePaymentRecordBodySchema>
export type CreateCertificateBody = z.infer<typeof CreateCertificateBodySchema>
export type UpdateCertificateBody = z.infer<typeof UpdateCertificateBodySchema>
export type CreateDomainRecordBody = z.infer<typeof CreateDomainRecordBodySchema>
export type UpdateDomainRecordBody = z.infer<typeof UpdateDomainRecordBodySchema>
export type ServiceParams = z.infer<typeof ServiceParamsSchema>
export type CertificateParams = z.infer<typeof CertificateParamsSchema>
export type DomainRecordParams = z.infer<typeof DomainRecordParamsSchema>
