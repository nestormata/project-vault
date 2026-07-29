import { z } from 'zod/v4'

// Story 17.1 AC-4: default 24h, cap 7 days — a judgment call documented in the Dev Agent Record,
// informed by the sensitivity of secret material (no other product guidance existed at dev time).
export const SHARE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const SHARE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const CredentialShareParamsSchema = z.object({
  projectId: z.uuid(),
  credentialId: z.uuid(),
})

export const CredentialShareRevokeParamsSchema = CredentialShareParamsSchema.extend({
  shareId: z.uuid(),
})

export const CreateCredentialShareBodySchema = z
  .object({
    recipientUserId: z.uuid(),
    fieldKey: z.string().trim().min(1).max(64).optional(),
    expiresAt: z.iso.datetime({ offset: true }),
    singleUse: z.boolean().default(true),
  })
  .strict()

export const CredentialShareStatusSchema = z.enum([
  'active',
  'viewed',
  'revoked',
  'expired',
  'superseded',
])

export const CredentialShareSummarySchema = z.object({
  id: z.uuid(),
  credentialId: z.uuid(),
  fieldKey: z.string().nullable(),
  sharedBy: z.uuid(),
  recipientUserId: z.uuid().nullable(),
  singleUse: z.boolean(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  firstViewedAt: z.iso.datetime().nullable(),
  viewCount: z.number().int(),
  status: CredentialShareStatusSchema,
})

export const CreateCredentialShareResponseSchema = z.object({
  data: CredentialShareSummarySchema.extend({
    // Story 17.1 AC-7: the raw token is returned exactly once, at creation, and never again —
    // only its hash is ever persisted.
    token: z.string(),
  }),
})

export const ListCredentialSharesResponseSchema = z.object({
  data: z.object({ items: z.array(CredentialShareSummarySchema) }),
})

export const RevokeCredentialShareResponseSchema = z.object({
  data: CredentialShareSummarySchema,
})

export const ShareAccessParamsSchema = z.object({ token: z.string().min(1) })

export const ShareMetadataResponseSchema = z.object({
  data: z.object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    sharedBy: z.uuid(),
    sharedByEmail: z.string().nullable(),
    fieldKey: z.string().nullable(),
    expiresAt: z.iso.datetime(),
    singleUse: z.boolean(),
    status: CredentialShareStatusSchema,
  }),
})

export const ShareRevealResponseSchema = z.object({
  data: z.object({
    credentialId: z.uuid(),
    fieldKey: z.string().nullable(),
    value: z.string(),
    viewedAt: z.iso.datetime(),
  }),
})

export type CreateCredentialShareBody = z.infer<typeof CreateCredentialShareBodySchema>
export type CredentialShareParams = z.infer<typeof CredentialShareParamsSchema>
export type CredentialShareRevokeParams = z.infer<typeof CredentialShareRevokeParamsSchema>
export type ShareAccessParams = z.infer<typeof ShareAccessParamsSchema>
