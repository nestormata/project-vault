import { and, eq, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  paymentRecords,
  certRecords,
  domainRecords,
  notificationQueue,
} from '@project-vault/db/schema'
import type {
  CreateCertificateBody,
  CreateDomainRecordBody,
  CreatePaymentRecordBody,
  UpdateCertificateBody,
  UpdateDomainRecordBody,
  UpdatePaymentRecordBody,
} from './schema.js'

export const PAYMENT_DEFAULT_ALERT_LEAD_DAYS = [14, 3]
export const CERTIFICATE_DEFAULT_ALERT_LEAD_DAYS = [30, 7]
export const DOMAIN_DEFAULT_ALERT_LEAD_DAYS = [30]

/**
 * AC 7: deleting a service/certificate/domain record must cancel any notifications still
 * queued for it (a hard delete leaves nothing else to point the notification at). A plain
 * `payload->>'assetId'` match is fine here — no index is required for the low pending-row
 * cardinality per org (see story AC 7 note).
 */
export async function suppressPendingNotificationsForAsset(
  tx: Tx,
  params: { orgId: string; assetId: string }
): Promise<void> {
  await tx
    .update(notificationQueue)
    .set({ status: 'suppressed' })
    .where(
      and(
        eq(notificationQueue.orgId, params.orgId),
        eq(notificationQueue.status, 'pending'),
        sql`${notificationQueue.payload}->>'assetId' = ${params.assetId}`
      )
    )
}

// --- Serializers ---

export function serializePaymentRecord(row: typeof paymentRecords.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    name: row.name,
    url: row.url,
    renewalDate: row.renewalDate?.toISOString() ?? null,
    alertLeadDays: row.alertLeadDays,
    notifiedLeadDays: row.notifiedLeadDays,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeCertificateRecord(row: typeof certRecords.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    domain: row.domain,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    alertLeadDays: row.alertLeadDays,
    notifiedLeadDays: row.notifiedLeadDays,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeDomainRecord(row: typeof domainRecords.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    domainName: row.domainName,
    renewalDate: row.renewalDate?.toISOString() ?? null,
    alertLeadDays: row.alertLeadDays,
    notifiedLeadDays: row.notifiedLeadDays,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// --- Services (payment_records) ---

export async function listPaymentRecords(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.projectId, projectId))
    .orderBy(paymentRecords.createdAt)
  return rows.map(serializePaymentRecord)
}

export async function createPaymentRecord(
  tx: Tx,
  input: { orgId: string; projectId: string; userId: string; body: CreatePaymentRecordBody }
) {
  const [row] = await tx
    .insert(paymentRecords)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.body.name,
      url: input.body.url ?? null,
      renewalDate: input.body.renewalDate ? new Date(input.body.renewalDate) : null,
      alertLeadDays: input.body.alertLeadDays ?? PAYMENT_DEFAULT_ALERT_LEAD_DAYS,
      createdBy: input.userId,
    })
    .returning()
  if (!row) throw new Error('Payment record insert returned no row')
  return row
}

export async function findPaymentRecordInProject(
  tx: Tx,
  params: { serviceId: string; projectId: string }
) {
  const [row] = await tx
    .select()
    .from(paymentRecords)
    .where(
      and(eq(paymentRecords.id, params.serviceId), eq(paymentRecords.projectId, params.projectId))
    )
    .limit(1)
  return row ?? null
}

export async function updatePaymentRecord(
  tx: Tx,
  input: {
    serviceId: string
    projectId: string
    body: UpdatePaymentRecordBody
    rawBody: Record<string, unknown>
  }
) {
  const updates: Partial<typeof paymentRecords.$inferInsert> = {}
  if ('url' in input.rawBody) updates.url = input.body.url ?? null
  if ('renewalDate' in input.rawBody) {
    updates.renewalDate = input.body.renewalDate ? new Date(input.body.renewalDate) : null
    // AC 6: any change to the renewal date resets the alert cycle.
    updates.notifiedLeadDays = []
  }
  if ('alertLeadDays' in input.rawBody) updates.alertLeadDays = input.body.alertLeadDays

  const [updated] = await tx
    .update(paymentRecords)
    .set(updates)
    .where(
      and(eq(paymentRecords.id, input.serviceId), eq(paymentRecords.projectId, input.projectId))
    )
    .returning()
  return updated ?? null
}

export async function deletePaymentRecord(
  tx: Tx,
  params: { serviceId: string; projectId: string }
) {
  const [deleted] = await tx
    .delete(paymentRecords)
    .where(
      and(eq(paymentRecords.id, params.serviceId), eq(paymentRecords.projectId, params.projectId))
    )
    .returning()
  return deleted ?? null
}

// --- Certificates (cert_records) ---

export async function listCertificateRecords(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(certRecords)
    .where(eq(certRecords.projectId, projectId))
    .orderBy(certRecords.createdAt)
  return rows.map(serializeCertificateRecord)
}

export async function createCertificateRecord(
  tx: Tx,
  input: { orgId: string; projectId: string; userId: string; body: CreateCertificateBody }
) {
  const [row] = await tx
    .insert(certRecords)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      domain: input.body.domain,
      expiresAt: new Date(input.body.expiresAt),
      alertLeadDays: input.body.alertLeadDays ?? CERTIFICATE_DEFAULT_ALERT_LEAD_DAYS,
      createdBy: input.userId,
    })
    .returning()
  if (!row) throw new Error('Certificate record insert returned no row')
  return row
}

export async function findCertificateRecordInProject(
  tx: Tx,
  params: { certificateId: string; projectId: string }
) {
  const [row] = await tx
    .select()
    .from(certRecords)
    .where(
      and(eq(certRecords.id, params.certificateId), eq(certRecords.projectId, params.projectId))
    )
    .limit(1)
  return row ?? null
}

export async function updateCertificateRecord(
  tx: Tx,
  input: {
    certificateId: string
    projectId: string
    body: UpdateCertificateBody
    rawBody: Record<string, unknown>
  }
) {
  const updates: Partial<typeof certRecords.$inferInsert> = {}
  if ('domain' in input.rawBody) updates.domain = input.body.domain
  if ('expiresAt' in input.rawBody) {
    updates.expiresAt = input.body.expiresAt ? new Date(input.body.expiresAt) : null
    // AC 6: any change to the expiry date resets the alert cycle.
    updates.notifiedLeadDays = []
  }
  if ('alertLeadDays' in input.rawBody) updates.alertLeadDays = input.body.alertLeadDays

  const [updated] = await tx
    .update(certRecords)
    .set(updates)
    .where(and(eq(certRecords.id, input.certificateId), eq(certRecords.projectId, input.projectId)))
    .returning()
  return updated ?? null
}

export async function deleteCertificateRecord(
  tx: Tx,
  params: { certificateId: string; projectId: string }
) {
  const [deleted] = await tx
    .delete(certRecords)
    .where(
      and(eq(certRecords.id, params.certificateId), eq(certRecords.projectId, params.projectId))
    )
    .returning()
  return deleted ?? null
}

// --- Domains (domain_records) ---

export async function listDomainRecords(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(domainRecords)
    .where(eq(domainRecords.projectId, projectId))
    .orderBy(domainRecords.createdAt)
  return rows.map(serializeDomainRecord)
}

export async function createDomainRecord(
  tx: Tx,
  input: { orgId: string; projectId: string; userId: string; body: CreateDomainRecordBody }
) {
  const [row] = await tx
    .insert(domainRecords)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      domainName: input.body.domainName,
      renewalDate: new Date(input.body.renewalDate),
      alertLeadDays: input.body.alertLeadDays ?? DOMAIN_DEFAULT_ALERT_LEAD_DAYS,
      createdBy: input.userId,
    })
    .returning()
  if (!row) throw new Error('Domain record insert returned no row')
  return row
}

export async function findDomainRecordInProject(
  tx: Tx,
  params: { domainId: string; projectId: string }
) {
  const [row] = await tx
    .select()
    .from(domainRecords)
    .where(
      and(eq(domainRecords.id, params.domainId), eq(domainRecords.projectId, params.projectId))
    )
    .limit(1)
  return row ?? null
}

export async function updateDomainRecord(
  tx: Tx,
  input: {
    domainId: string
    projectId: string
    body: UpdateDomainRecordBody
    rawBody: Record<string, unknown>
  }
) {
  const updates: Partial<typeof domainRecords.$inferInsert> = {}
  if ('domainName' in input.rawBody) updates.domainName = input.body.domainName
  if ('renewalDate' in input.rawBody) {
    updates.renewalDate = input.body.renewalDate ? new Date(input.body.renewalDate) : null
    // AC 6: any change to the renewal date resets the alert cycle.
    updates.notifiedLeadDays = []
  }
  if ('alertLeadDays' in input.rawBody) updates.alertLeadDays = input.body.alertLeadDays

  const [updated] = await tx
    .update(domainRecords)
    .set(updates)
    .where(and(eq(domainRecords.id, input.domainId), eq(domainRecords.projectId, input.projectId)))
    .returning()
  return updated ?? null
}

export async function deleteDomainRecord(tx: Tx, params: { domainId: string; projectId: string }) {
  const [deleted] = await tx
    .delete(domainRecords)
    .where(
      and(eq(domainRecords.id, params.domainId), eq(domainRecords.projectId, params.projectId))
    )
    .returning()
  return deleted ?? null
}
