import { z } from 'zod/v4'

export {
  LoginRequestSchema,
  RegisterRequestSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@project-vault/shared'

export const mfaEnrollResponseSchema = z.object({
  data: z.object({
    enrollmentId: z.uuid(),
    otpauthUrl: z.string().startsWith('otpauth://'),
    secret: z.string().min(16).max(64),
    qrCodeSvg: z.string().startsWith('<svg'),
  }),
})

export const mfaVerifyEnrollmentBodySchema = z.object({
  totp: z.string().regex(/^\d{6}$/, 'TOTP must be exactly 6 digits'),
})

export const mfaRegenerateBodySchema = mfaVerifyEnrollmentBodySchema

export const mfaRecoverBodySchema = z.object({
  email: z.email(),
  password: z.string().min(12).max(128),
  recoveryCode: z.string().min(10).max(16),
})

export const mfaVerifyEnrollmentResponseSchema = z.object({
  data: z.object({
    mfaEnrolledAt: z.iso.datetime(),
    recoveryCodes: z.array(z.string()),
  }),
})

export const mfaRegenerateResponseSchema = z.object({
  data: z.object({
    recoveryCodes: z.array(z.string()),
    generatedAt: z.iso.datetime(),
  }),
})

export const mfaRecoverResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    expiresAt: z.iso.datetime(),
    remainingRecoveryCodes: z.number().int().min(0),
  }),
})

export const authMeResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    sessionId: z.uuid(),
    orgRole: z.enum(['owner', 'admin', 'member', 'viewer']),
    mfaEnrolled: z.boolean(),
    mfaEnrolledAt: z.iso.datetime().nullable(),
    remainingRecoveryCodesCount: z.number().int().min(0).nullable(),
  }),
})

export type MfaVerifyEnrollmentBody = z.infer<typeof mfaVerifyEnrollmentBodySchema>
export type MfaRegenerateBody = z.infer<typeof mfaRegenerateBodySchema>
export type MfaRecoverBody = z.infer<typeof mfaRecoverBodySchema>
