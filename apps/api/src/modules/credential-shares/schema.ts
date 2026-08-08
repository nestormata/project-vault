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

// Story 17.3 AC-2: mirrors the limit/offset (not page-based) convention the AC explicitly asks
// for — default 25, clamp (never reject) an over-large limit to 100, matching this codebase's
// existing "clamp, don't 400, on an over-large but otherwise well-formed limit" convention
// (`parsePagination` in apps/api/src/lib/pagination.ts does the identical `Math.min` clamp for
// its own page/limit shape).
export const DEFAULT_SHARE_LIST_LIMIT = 25
export const MAX_SHARE_LIST_LIMIT = 100

export const CredentialShareParamsSchema = z.object({
  projectId: z.uuid(),
  credentialId: z.uuid(),
})

export const CredentialShareRevokeParamsSchema = CredentialShareParamsSchema.extend({
  shareId: z.uuid(),
})

// Story 20.5 AC-1 (Scoped/Bounded Sharing Contract, decided by Story 20.4 in architecture.md):
// `attributeKeys: string[] | null` generalizes `fieldKey` without narrowing its existing behavior
// — `null` (or omitted) means "whole-resource, sensitivity-default-exclusion applies" (AC-2); a
// non-empty array is an explicit allow-list of attribute/field keys, included whether sensitive
// or not (naming a key is explicit consent). `.min(1)` on the array itself rejects an explicit
// `[]`, which would be ambiguous ("named nothing" vs "whole-resource") rather than a meaningful
// third state.
//
// Bugfix (review patch): the 50-key cap is deliberately NOT enforced here as a raw `.max(50)` —
// `validateAttributeKeys` (service.ts) dedupes keys on their normalized (trim/case-folded) form,
// so a caller sending 50 keys where one is a case/whitespace duplicate of another would otherwise
// be rejected for exceeding the cap even though the deduplicated set fits within it. The cap is
// instead enforced post-dedup in `validateAttributeKeys`, returning a proper validation result
// rather than a Zod parse failure. This schema's role is limited to shape/type validation only.
export const AttributeKeysSchema = z.array(z.string().trim().min(1).max(64)).min(1).nullable()

// The cap itself (see `AttributeKeysSchema`'s comment above for why it's enforced post-dedup in
// `validateAttributeKeys`, service.ts, rather than as a raw `.max()` on this schema).
export const MAX_ATTRIBUTE_KEYS = 50

// Story 20.5 AC-1: `action` accepts only `'read'` in this contract version — `z.literal('read')`
// rejects any other value with the schema's own validation error rather than silently coercing it
// (a request that omits `action` defaults to `'read'`, which is a default, not a coercion of an
// explicitly-wrong value).
export const ShareActionSchema = z.literal('read').default('read')

// Story 20.5: `fieldKey` and `attributeKeys` are two spellings of the same scope concept — a
// request supplying both is ambiguous, not additive, so it is rejected rather than silently
// preferring one over the other. Shared by both create-share body schemas below so the rule (and
// its error shape) can never drift between the member and external-recipient variants.
function rejectBothFieldKeyAndAttributeKeys<
  T extends { fieldKey?: string; attributeKeys?: string[] | null },
>(schema: z.ZodType<T>) {
  return schema.refine((body) => !(body.fieldKey && body.attributeKeys), {
    message: 'Specify at most one of fieldKey or attributeKeys.',
    path: ['attributeKeys'],
  })
}

// Story 20.5 AC-1: the `BoundedShareScope` fields shared by both create-share body schemas —
// spread into each `.object()` below rather than repeated, so the two variants' `fieldKey`/
// `attributeKeys`/`action`/`expiresAt` declarations can never drift apart.
const boundedShareScopeRequestShape = {
  fieldKey: z.string().trim().min(1).max(64).optional(),
  attributeKeys: AttributeKeysSchema.optional(),
  action: ShareActionSchema,
  expiresAt: z.iso.datetime({ offset: true }),
}

export const CreateCredentialShareBodySchema = rejectBothFieldKeyAndAttributeKeys(
  z
    .object({
      recipientUserId: z.uuid(),
      ...boundedShareScopeRequestShape,
      singleUse: z.boolean().default(true),
    })
    .strict()
)

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
  // Story 20.5 AC-1: the persisted `BoundedShareScope` fields.
  attributeKeys: z.array(z.string()).nullable(),
  action: z.literal('read'),
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
// `recipientEmail` replaces `recipientUserId`. `singleUse` is accepted (AC-5: caller may omit it
// or pass `true`) but never trusted as-is — the route rejects an explicit `false` with a
// dedicated 400 `external_share_must_be_single_use` rather than the generic `.strict()` 422 a
// caller would get for an unrecognized field, and `createExternalCredentialShare` still
// hard-codes `singleUse: true` on the insert regardless of what was validated here. The step-up
// factor (`password` xor `totpCode`) is part of this same body (AC-3) — validated for shape here,
// verified for correctness by the step-up helper, never persisted.
export const CreateExternalCredentialShareBodySchema = rejectBothFieldKeyAndAttributeKeys(
  z
    .object({
      recipientEmail: z.email().trim().max(320),
      ...boundedShareScopeRequestShape,
      singleUse: z.boolean().optional(),
      password: z.string().min(1).max(512).optional(),
      totpCode: z.string().trim().min(1).max(16).optional(),
    })
    .strict()
)

export const ExternalCredentialShareSummarySchema = CredentialShareSummarySchema

export const CreateExternalCredentialShareResponseSchema = z.object({
  data: ExternalCredentialShareSummarySchema.extend({
    token: z.string(),
  }),
})

export const ExternalShareAccessParamsSchema = z.object({ token: z.string().min(1) })

// Story 20.5 (review patch): the recipient-visible `BoundedShareScope` fields — surfaced so a
// recipient can tell they're looking at a bounded subset of fields, not an ordinary
// whole-credential share (the sharer-facing summary already carries these; the recipient-facing
// metadata/reveal responses previously silently dropped them). Spread into every recipient-facing
// response schema below so they can never drift apart, mirroring `boundedShareScopeRequestShape`'s
// identical role for the create-share request bodies above.
const boundedShareScopeResponseShape = {
  fieldKey: z.string().nullable(),
  attributeKeys: z.array(z.string()).nullable(),
  action: z.literal('read'),
}

// Story 17.2 AC-9: metadata only — credential name, sharer *display name* (not email, so an
// unauthenticated party never learns an org member's address), field if scoped, expiry. No
// `sharedByEmail` field at all (unlike 17.1's authenticated-recipient metadata response).
export const ExternalShareMetadataResponseSchema = z.object({
  data: z.object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    sharedByDisplayName: z.string(),
    ...boundedShareScopeResponseShape,
    expiresAt: z.iso.datetime(),
    status: CredentialShareStatusSchema,
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

// Story 17.3 AC-1/AC-2: optional status filter + limit/offset pagination on the existing list
// route. `status` invalid-enum-value -> 422 (zod's own enum validation). `limit`/`offset` are
// deliberately unbounded-above at this schema layer — the route handler clamps an over-large
// `limit` down to `MAX_SHARE_LIST_LIMIT` rather than rejecting it (this codebase's existing
// "clamp, don't 400, on an over-large but otherwise well-formed limit" convention, matching
// `parsePagination`'s identical `Math.min` clamp for its own page/limit shape) — a `.max()` here
// would 422 instead of clamp, the wrong behavior per AC-2's edge case.
export const ListCredentialSharesQuerySchema = z.object({
  status: CredentialShareStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})
export type ListCredentialSharesQuery = z.infer<typeof ListCredentialSharesQuerySchema>

export const ListCredentialSharesResponseSchema = z.object({
  data: z.object({ items: z.array(CredentialShareSummarySchema), total: z.number().int() }),
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
    ...boundedShareScopeResponseShape,
    expiresAt: z.iso.datetime(),
    singleUse: z.boolean(),
    status: CredentialShareStatusSchema,
  }),
})

export const ShareRevealResponseSchema = z.object({
  data: z.object({
    credentialId: z.uuid(),
    ...boundedShareScopeResponseShape,
    value: z.string(),
    valueFormat: z.enum(['scalar', 'fields']),
    viewedAt: z.iso.datetime(),
  }),
})

// Story 17.2: identical response shape to the authenticated reveal — the external recipient
// receives the same { credentialId, fieldKey, value, viewedAt } envelope.
export const ExternalShareRevealResponseSchema = ShareRevealResponseSchema

// Story 17.3 AC-11/Task 5.1: a small, dedicated `GET .../nudge` route rather than folding into
// the existing credential-detail response — documented as the dev agent's choice (see Dev Agent
// Record): keeps this module's own contract self-contained and avoids widening the credentials
// module's response schema for a feature that belongs to credential-shares.
export const RotationRecommendedBucketSchema = z.object({
  fieldKey: z.string().nullable(),
  active: z.boolean(),
  mostRecentShareAt: z.iso.datetime().nullable(),
  mostRecentSharedWith: z.string().nullable(),
})

export const ListNudgeResponseSchema = z.object({
  data: z.object({ items: z.array(RotationRecommendedBucketSchema) }),
})

// Story 17.3 AC-15: `reason` is required and non-empty after trimming — `.trim().min(1)` rejects
// an empty or whitespace-only reason with a 422 at this schema layer (the service layer's own
// `dismissRotationRecommendedNudge` re-checks this too, so a future non-HTTP caller gets the same
// guarantee without depending on this schema).
export const DismissNudgeBodySchema = z
  .object({
    fieldKey: z.string().trim().min(1).max(64).optional(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()

export const DismissNudgeResponseSchema = z.object({
  data: z.object({
    fieldKey: z.string().nullable(),
    dismissedAt: z.iso.datetime(),
  }),
})

export type DismissNudgeBody = z.infer<typeof DismissNudgeBodySchema>

export type CreateCredentialShareBody = z.infer<typeof CreateCredentialShareBodySchema>
export type CredentialShareParams = z.infer<typeof CredentialShareParamsSchema>
export type CredentialShareRevokeParams = z.infer<typeof CredentialShareRevokeParamsSchema>
export type ShareAccessParams = z.infer<typeof ShareAccessParamsSchema>
