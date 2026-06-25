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

export const VaultInitRequestSchema = z.discriminatedUnion('kmsType', [
  PassphraseInitSchema,
  EnvelopeInitSchema,
  FileInitSchema,
])

export type VaultInitRequest = z.infer<typeof VaultInitRequestSchema>

export const VaultInitResponseSchema = z.object({
  initialized: z.literal(true),
  keyVersion: z.number().int().positive(),
  kmsType: z.enum(['passphrase', 'envelope', 'file']),
})

/** Unseal body — fields validated server-side against stored kms_type. */
export const VaultUnsealRequestSchema = z
  .object({
    passphrase: z.string().min(12).optional(),
    envelopeKeyPath: z.string().min(1).optional(),
    masterKeyPath: z.string().min(1).optional(),
  })
  .refine(
    (body) =>
      [body.passphrase, body.envelopeKeyPath, body.masterKeyPath].filter(Boolean).length === 1,
    { message: 'Provide exactly one of: passphrase, envelopeKeyPath, or masterKeyPath' }
  )

export type VaultUnsealRequest = z.infer<typeof VaultUnsealRequestSchema>

export const VaultUnsealResponseSchema = z.object({
  unsealed: z.literal(true),
  keyVersion: z.number().int().positive(),
  kmsType: z.enum(['passphrase', 'envelope', 'file']),
})
