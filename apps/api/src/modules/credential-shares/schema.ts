import { z } from 'zod/v4'

// Story 17.1 AC-4: default 24h, cap 7 days — a judgment call documented in the Dev Agent Record,
// informed by the sensitivity of secret material (no other product guidance existed at dev time).
export const SHARE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const SHARE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Story 17.2 AC-5: materially tighter than 17.1's member-share TTLs — an external link has no
// account behind it at all, so anyone who obtains the URL (forwarded mail, a compromised inbox, a
// "safe link" scanning proxy that stores the URL) can use it. Default 1h, capped at 72h (3 days).
export const EXTERNAL_SHARE_DEFAULT_TTL_MS = 60 * 60 * 1000
export const EXTERNAL_SHARE_MAX_TTL_MS = 72 * 60 * 60 * 1000

// Story 17.2 AC-16: a fixed code constant (no per-org-configurable settings surface exists that
// fits this cleanly — see Dev Notes) capping concurrent, not-yet-resolved external shares per
// (credentialId, fieldKey) bucket (fieldKey IS NULL is its own bucket).
export const MAX_PENDING_EXTERNAL_SHARES_PER_FIELD = 5

// Story 17.2 AC-22: per-token reveal-attempt cap (a claim-attempt that resolves to a real row but
// loses) — exceeding this auto-revokes the share. A judgment call documented in the Dev Agent
// Record; defense-in-depth on top of the token's own 256-bit entropy.
export const EXTERNAL_SHARE_MAX_REVEAL_ATTEMPTS = 5

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
  recipientType: z.enum(['user', 'external']),
  recipientUserId: z.uuid().nullable(),
  recipientEmail: z.string().nullable(),
  singleUse: z.boolean(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  firstViewedAt: z.iso.datetime().nullable(),
  viewCount: z.number().int(),
  status: CredentialShareStatusSchema,
})

// Story 17.2 AC-1/AC-3/AC-5: the external-recipient sibling of CreateCredentialShareBodySchema.
// `recipientEmail` replaces `recipientUserId`; `singleUse` is deliberately absent from the body
// shape entirely — hard-coded true server-side (AC-5) rather than accepted-and-validated, so a
// caller cannot even express `singleUse: false` via a typo'd extra field slipping past `.strict()`
// the way an optional-with-default field could. The step-up factor (`password` xor `totpCode`) is
// part of this same body (AC-3) — validated for shape here, verified for correctness by the
// step-up helper, never persisted.
export const CreateExternalCredentialShareBodySchema = z
  .object({
    recipientEmail: z.email().trim().max(320),
    fieldKey: z.string().trim().min(1).max(64).optional(),
    expiresAt: z.iso.datetime({ offset: true }),
    password: z.string().min(1).max(512).optional(),
    totpCode: z.string().trim().min(1).max(16).optional(),
  })
  .strict()

export const ExternalCredentialShareSummarySchema = CredentialShareSummarySchema

export const CreateExternalCredentialShareResponseSchema = z.object({
  data: ExternalCredentialShareSummarySchema.extend({
    token: z.string(),
  }),
})

export const ExternalShareAccessParamsSchema = z.object({ token: z.string().min(1) })

// Story 17.2 AC-9: metadata only — credential name, sharer *display name* (not email, so an
// unauthenticated party never learns an org member's address), field if scoped, expiry. No
// `sharedByEmail` field at all (unlike 17.1's authenticated-recipient metadata response).
export const ExternalShareMetadataResponseSchema = z.object({
  data: z.object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    sharedByDisplayName: z.string(),
    fieldKey: z.string().nullable(),
    expiresAt: z.iso.datetime(),
    status: CredentialShareStatusSchema,
  }),
})

export const ExternalShareRevealResponseSchema = z.object({
  data: z.object({
    credentialId: z.uuid(),
    fieldKey: z.string().nullable(),
    value: z.string(),
    viewedAt: z.iso.datetime(),
  }),
})

export type CreateExternalCredentialShareBody = z.infer<
  typeof CreateExternalCredentialShareBodySchema
>
export type ExternalShareAccessParams = z.infer<typeof ExternalShareAccessParamsSchema>

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
