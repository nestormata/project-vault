import { z } from 'zod/v4'

const PassphraseInitSchema = z.object({
  kmsType: z.literal('passphrase'),
  passphrase: z.string().min(12, 'Passphrase must be at least 12 characters'),
})

const EnvelopeInitSchema = z.object({
  kmsType: z.literal('envelope'),
  envelopeKeyPath: z.string().min(1),
  acknowledgeSplitKeyModel: z.literal(true, {
    error: 'Envelope mode requires acknowledgeSplitKeyModel: true',
  }),
})

const FileInitSchema = z.object({
  kmsType: z.literal('file'),
  masterKeyPath: z.string().min(1),
  acknowledgeCoLocationRisk: z.literal(true, {
    error: 'File mode requires acknowledgeCoLocationRisk: true — not recommended for production',
  }),
})

// Story 1.14 AC-8: no acknowledge* flag — KMS is the most-secure mode, not a downgraded one.
const KmsInitSchema = z.object({
  kmsType: z.literal('kms'),
  kmsKeyId: z.string().min(1),
})

export const VaultInitRequestSchema = z.discriminatedUnion('kmsType', [
  PassphraseInitSchema,
  EnvelopeInitSchema,
  FileInitSchema,
  KmsInitSchema,
])

export type VaultInitRequest = z.infer<typeof VaultInitRequestSchema>

export const VaultInitResponseSchema = z.object({
  initialized: z.literal(true),
  keyVersion: z.number().int().positive(),
  kmsType: z.enum(['passphrase', 'envelope', 'file', 'kms']),
})

/** Unseal body — fields validated server-side against stored kms_type. Story 1.14 AC-10: the
 * Zod layer cannot know the stored mode, so it only enforces "at most one legacy field, OR
 * zero" — the zero-field case is valid Zod-wise for every mode, but `unsealVault()` in
 * key-service.ts still rejects it for non-kms modes via the existing per-mode required-field
 * checks (`deriveIkmForUnseal`), unchanged for passphrase/envelope/file. */
export const VaultUnsealRequestSchema = z
  .object({
    passphrase: z.string().min(12).optional(),
    envelopeKeyPath: z.string().min(1).optional(),
    masterKeyPath: z.string().min(1).optional(),
  })
  .refine(
    (body) =>
      [body.passphrase, body.envelopeKeyPath, body.masterKeyPath].filter(Boolean).length <= 1,
    { message: 'Provide at most one of: passphrase, envelopeKeyPath, or masterKeyPath' }
  )

export type VaultUnsealRequest = z.infer<typeof VaultUnsealRequestSchema>

export const VaultUnsealResponseSchema = z.object({
  unsealed: z.literal(true),
  keyVersion: z.number().int().positive(),
  kmsType: z.enum(['passphrase', 'envelope', 'file', 'kms']),
})

/** Vault init/unseal error shape (`{error, message}`, not the rest of the API's `{code, message}` ApiErrorSchema). */
export const VaultErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
})
