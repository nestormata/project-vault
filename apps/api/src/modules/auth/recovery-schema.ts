import { z } from 'zod/v4'
import { PasswordSchema } from '@project-vault/shared'

// Shared 429 shape for every DB-backed dual-bucket rate limiter in this module (enforceRecoverRateLimit) —
// reused by both /mfa/recover and /recovery/request so the two don't carry duplicate inline schemas.
export const RateLimitExceededResponseSchema = z.object({
  code: z.literal('rate_limit_exceeded'),
  message: z.string(),
  retryAfterSeconds: z.number().int().positive(),
})

export const RecoveryRequestBodySchema = z
  .object({ email: z.email().max(254) })
  .strict()
  .meta({ id: 'RecoveryRequestBody' })

export const RecoveryRequestResponseSchema = z
  .object({ message: z.string() })
  .meta({ id: 'RecoveryRequestResponse' })

export const RecoveryNoAdminResponseSchema = z
  .object({ code: z.literal('no_admin_available'), message: z.string() })
  .meta({ id: 'RecoveryNoAdminResponse' })

export const RecoveryTokenParamsSchema = z
  .object({ token: z.string().min(1).max(512) })
  .meta({ id: 'RecoveryTokenParams' })

export const RecoveryPeekResponseSchema = z
  .object({
    data: z.object({
      email: z.string(),
      mfaCurrentlyEnrolled: z.boolean(),
    }),
  })
  .meta({ id: 'RecoveryPeekResponse' })

export const RecoveryMfaStartResponseSchema = z
  .object({
    data: z.object({
      otpauthUrl: z.string().startsWith('otpauth://'),
      secret: z.string().min(16).max(64),
      qrCodeSvg: z.string().startsWith('<svg'),
    }),
  })
  .meta({ id: 'RecoveryMfaStartResponse' })

export const RecoveryCompleteBodySchema = z
  .object({
    newPassword: PasswordSchema,
    totpCode: z
      .string()
      .refine((value) => /^\d{6}$/.test(value.replace(/\s/g, '')), 'TOTP must be exactly 6 digits')
      .optional(),
  })
  .strict()
  .meta({ id: 'RecoveryCompleteBody' })

export const RecoveryCompleteResponseSchema = z
  .object({
    data: z.object({
      email: z.email(),
      sessionsRevoked: z.number().int().min(0),
      mfaReEnrolled: z.boolean(),
      recoveryCodes: z.array(z.string()).optional(),
    }),
  })
  .meta({ id: 'RecoveryCompleteResponse' })

export type RecoveryRequestBody = z.infer<typeof RecoveryRequestBodySchema>
export type RecoveryTokenParams = z.infer<typeof RecoveryTokenParamsSchema>
export type RecoveryCompleteBody = z.infer<typeof RecoveryCompleteBodySchema>
