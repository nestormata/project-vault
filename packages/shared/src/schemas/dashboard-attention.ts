import { z } from 'zod/v4'

// Story 72-12 (P8): what needs attention on the dashboard. One flat list, typed by `kind`, built per
// viewer on the server from rows that viewer can already read through the existing list routes.

/** An active share is attention-worthy this many days before it expires (A2). */
export const ATTENTION_SHARE_HORIZON_DAYS = 7
/** A certificate is attention-worthy this many days before it expires (the default alert lead, A2). */
export const ATTENTION_CERTIFICATE_HORIZON_DAYS = 30
/** At most this many items of each kind are returned; `counts` carries the true totals (A8). */
export const ATTENTION_ITEMS_PER_KIND = 10

export const ATTENTION_KINDS = [
  'expiring_share',
  'expiring_certificate',
  'pending_invitation',
] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

const attentionBase = {
  id: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  /** The instant that makes the item urgent: share or certificate expiry, invitation expiry. */
  dueAt: z.iso.datetime(),
}

export const ExpiringShareAttentionItemSchema = z
  .object({
    ...attentionBase,
    kind: z.literal('expiring_share'),
    credentialId: z.uuid(),
    credentialName: z.string(),
    /** The external recipient's address; null for a share to a member of the organization. */
    recipientEmail: z.string().nullable(),
  })
  .meta({ id: 'ExpiringShareAttentionItem' })

export const ExpiringCertificateAttentionItemSchema = z
  .object({
    ...attentionBase,
    kind: z.literal('expiring_certificate'),
    domain: z.string(),
    /** True when the certificate has already expired (the most urgent case). */
    expired: z.boolean(),
  })
  .meta({ id: 'ExpiringCertificateAttentionItem' })

export const PendingInvitationAttentionItemSchema = z
  .object({
    ...attentionBase,
    kind: z.literal('pending_invitation'),
    email: z.string(),
    roleToAssign: z.enum(['admin', 'member', 'viewer']),
  })
  .meta({ id: 'PendingInvitationAttentionItem' })

export const AttentionItemSchema = z
  .discriminatedUnion('kind', [
    ExpiringShareAttentionItemSchema,
    ExpiringCertificateAttentionItemSchema,
    PendingInvitationAttentionItemSchema,
  ])
  .meta({ id: 'AttentionItem' })

export const AttentionCountsSchema = z
  .object({
    expiringShares: z.number().int().nonnegative(),
    expiringCertificates: z.number().int().nonnegative(),
    pendingInvitations: z.number().int().nonnegative(),
  })
  .meta({ id: 'AttentionCounts' })

export const DashboardAttentionSchema = z
  .object({
    items: z.array(AttentionItemSchema),
    counts: AttentionCountsSchema,
  })
  .meta({ id: 'DashboardAttention' })

export type AttentionItem = z.infer<typeof AttentionItemSchema>
export type AttentionCounts = z.infer<typeof AttentionCountsSchema>
export type DashboardAttention = z.infer<typeof DashboardAttentionSchema>
