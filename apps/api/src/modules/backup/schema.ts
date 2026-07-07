import { z } from 'zod/v4'

// Story 9.1 — kept local to apps/api/src/modules/backup (mirrors modules/vault/schema.ts and
// modules/compliance/schema.ts's convention) rather than packages/shared: this story's Product
// Surface Contract is API-only with no web consumer, so there is no cross-package type-sharing
// need that would justify packages/shared placement (openapi generation introspects the running
// app's route schemas regardless of where the Zod objects are defined).

export const BackupTriggerResponseSchema = z.object({
  data: z.object({
    jobId: z.string(),
    status: z.literal('running'),
  }),
})

export const BackupAlreadyRunningErrorSchema = z.object({
  code: z.literal('backup_already_running'),
  message: z.string(),
  jobId: z.string().nullable(),
})

export const BackupNotConfiguredErrorSchema = z.object({
  code: z.literal('backup_not_configured'),
  message: z.string(),
})

// AC-16: the global sealed-vault guard (Story 1.5) can also produce a 503 for this same route
// (`{ status: 'sealed', message }` — a different shape from BackupNotConfiguredErrorSchema's
// `{ code, message }`) before this route's own handler ever runs. Fastify's response
// serialization validates against the declared schema for whatever status code is actually sent,
// regardless of which layer (guard vs. handler) produced it — so the 503 response schema must
// accept both shapes, or the guard's own legitimate rejection would itself 500 on serialization.
export const VaultSealedResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
})

export const BackupListItemSchema = z.object({
  filename: z.string(),
  timestamp: z.string(),
  sizeBytes: z.number().nullable(),
  keyVersion: z.number().nullable(),
  verified: z.enum(['unverified', 'valid', 'invalid']),
})

export const BackupListResponseSchema = z.object({
  data: z.object({
    items: z.array(BackupListItemSchema),
  }),
})

export const BackupFilenameParamsSchema = z.object({
  filename: z.string().min(1),
})

// AC-9: confirmRestore/reason are both optional at the schema level (loosely validated) so a
// request missing one or both fails with the business-logic 400 confirmation_required response
// below, not a generic 422 schema-validation error — the AC's negative example omits
// confirmRestore entirely and still expects the specific confirmation_required code/message.
export const BackupRestoreBodySchema = z.object({
  confirmRestore: z.boolean().optional(),
  reason: z.string().min(1).optional(),
})

export const BackupRestoreResponseSchema = z.object({
  data: z.object({
    restored: z.literal(true),
    filename: z.string(),
    sealedAfterRestore: z.literal(true),
  }),
})

export const BackupConfirmationRequiredErrorSchema = z.object({
  code: z.literal('confirmation_required'),
  message: z.string(),
})

export const BackupChecksumMismatchErrorSchema = z.object({
  code: z.literal('backup_checksum_mismatch'),
  message: z.string(),
})

export const BackupNotFoundErrorSchema = z.object({
  code: z.literal('backup_not_found'),
  message: z.string(),
})

export const BackupDecryptFailedErrorSchema = z.object({
  code: z.literal('backup_decrypt_failed'),
  message: z.string(),
})

export const BackupAssetsPresentSchema = z.object({
  credentials: z.boolean(),
  projects: z.boolean(),
  users: z.boolean(),
  auditEvents: z.boolean(),
})

export const BackupValidateResponseSchema = z.object({
  data: z.object({
    valid: z.boolean(),
    assetsPresent: BackupAssetsPresentSchema,
    checksum: z.enum(['match', 'mismatch']),
  }),
})
