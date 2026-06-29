import { z } from 'zod/v4'

export const CredentialDetailSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    orgId: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    expiresAt: z.iso.datetime().nullable(),
    rotationSchedule: z.string().nullable(),
    retentionCount: z.number().int().min(1),
    currentVersionNumber: z.number().int().positive(),
    createdBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'CredentialDetail' })

export const CredentialValueSchema = z
  .object({
    value: z.string(),
    versionNumber: z.number().int().positive(),
    retrievedAt: z.iso.datetime(),
  })
  .meta({ id: 'CredentialValue' })

export const CredentialVersionSummarySchema = z
  .object({
    versionNumber: z.number().int().positive(),
    createdBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    isCurrent: z.boolean(),
    purgedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'CredentialVersionSummary' })

export const CredentialStatusSchema = z.enum(['active', 'expiring', 'expired'])

export const CredentialSummarySchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    status: CredentialStatusSchema,
    expiresAt: z.iso.datetime().nullable(),
    rotationSchedule: z.string().nullable(),
    currentVersionNumber: z.number().int().positive(),
    hasDependencies: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'CredentialSummary' })

export type CredentialDetail = z.infer<typeof CredentialDetailSchema>
export type CredentialValue = z.infer<typeof CredentialValueSchema>
export type CredentialVersionSummary = z.infer<typeof CredentialVersionSummarySchema>
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>
export type CredentialSummary = z.infer<typeof CredentialSummarySchema>
