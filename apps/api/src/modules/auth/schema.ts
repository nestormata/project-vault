import { z } from 'zod/v4'
import {
  RegisterResponseSchema,
  AuthSessionResponseSchema,
  SessionListResponseSchema,
  RevokeSessionsResponseSchema,
} from '@project-vault/shared'

function isTotpInput(value: string): boolean {
  return value.length === 6 && [...value].every((char) => char >= '0' && char <= '9')
}

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
  totp: z.string().refine(isTotpInput, 'TOTP must be exactly 6 digits'),
})

export const mfaRegenerateBodySchema = mfaVerifyEnrollmentBodySchema

export const mfaRecoverBodySchema = z.object({
  email: z.email(),
  password: z.string().min(12).max(128),
  recoveryCode: z.string().min(10).max(16),
})

export const mfaVerifyLoginBodySchema = z.object({
  mfaToken: z.string().min(16).max(64),
  totp: z.string().refine(isTotpInput, 'TOTP must be exactly 6 digits'),
})

export const mfaLoginRequiredResponseSchema = z.object({
  data: z.object({
    mfaRequired: z.literal(true),
    mfaToken: z.string(),
  }),
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

export const mfaVerifyLoginResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    expiresAt: z.iso.datetime(),
  }),
})

export const authMeResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    orgName: z.string(),
    sessionId: z.uuid(),
    orgRole: z.enum(['owner', 'admin', 'member', 'viewer']),
    isPlatformOperator: z.boolean(),
    mfaEnrolled: z.boolean(),
    mfaEnrolledAt: z.iso.datetime().nullable(),
    remainingRecoveryCodesCount: z.number().int().min(0).nullable(),
    mfaStatus: z.object({
      enrollmentRequired: z.boolean(),
      gracePeriodActive: z.boolean(),
      gracePeriodExpiresAt: z.iso.datetime().nullable(),
      gracePeriodDaysRemaining: z.number().int().min(0).nullable(),
      bannerMessage: z.string().nullable(),
    }),
    handoffDisplay: z
      .object({
        organizationName: z.string().optional(),
        tier: z.string().optional(),
        role: z.string().optional(),
      })
      .optional(),
  }),
})

export const registerRouteResponseSchema = z.object({ data: RegisterResponseSchema })

// Story 1.20 AC-3: self-signup registration's collapsed success/collision response — mirrors
// RecoveryRequestResponseSchema's `{ message }` shape exactly, plus `.strict()` (deliberately
// added here, unlike RecoveryRequestResponseSchema, since this schema's entire job is to
// guarantee no extra, potentially-identifying field ever leaks onto it — see recovery-schema.ts's
// `.strict()` convention on RecoveryRequestBodySchema).
export const RegisterAcceptedResponseSchema = z
  .object({ message: z.string() })
  .strict()
  .meta({ id: 'RegisterAcceptedResponse' })

export const loginResponseSchema = z.union([
  z.object({ data: AuthSessionResponseSchema }),
  mfaLoginRequiredResponseSchema,
])

export const refreshResponseSchema = z.object({
  data: z.object({ expiresAt: z.iso.datetime() }),
})

export const sessionsListResponseSchema = z.object({ data: SessionListResponseSchema })

export const revokeOtherSessionsResponseSchema = z.object({ data: RevokeSessionsResponseSchema })

export const methodNotAllowedResponseSchema = z.object({
  code: z.literal('method_not_allowed'),
  message: z.string(),
})

export const webauthnRegisterOptionsResponseSchema = z.object({
  data: z.object({
    challengeId: z.uuid(),
    options: z.record(z.string(), z.unknown()),
  }),
})

export const webauthnRegisterBodySchema = z.object({
  challengeId: z.uuid(),
  name: z.string().min(1).max(64),
  attestation: z
    .object({
      id: z.string().min(1),
      rawId: z.string().min(1),
      type: z.literal('public-key'),
      response: z
        .object({
          clientDataJSON: z.string().min(1),
          attestationObject: z.string().min(1),
        })
        .passthrough(),
    })
    .passthrough(),
})

export const webauthnRegisterResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime(),
  }),
})

export const webauthnCredentialListResponseSchema = z.object({
  data: z.object({
    credentials: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        createdAt: z.iso.datetime(),
        lastUsedAt: z.iso.datetime().nullable(),
        signCount: z.number().int().min(0),
      })
    ),
  }),
})

export const webauthnRenameBodySchema = z.object({
  name: z.string().min(1).max(64),
})

export const webauthnRenameResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    name: z.string(),
  }),
})

export const webauthnDeleteResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
  }),
})

export const webauthnCredentialParamsSchema = z.object({
  id: z.uuid(),
})

export type MfaVerifyEnrollmentBody = z.infer<typeof mfaVerifyEnrollmentBodySchema>
export type MfaRegenerateBody = z.infer<typeof mfaRegenerateBodySchema>
export type MfaRecoverBody = z.infer<typeof mfaRecoverBodySchema>
export type MfaVerifyLoginBody = z.infer<typeof mfaVerifyLoginBodySchema>
