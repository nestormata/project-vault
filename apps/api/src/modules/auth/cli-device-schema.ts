import { z } from 'zod/v4'
import { cliTokenPairSchema } from './cli-login-schema.js'

export const cliDeviceCreateBodySchema = z
  .object({
    clientName: z.string().trim().min(1).max(64).optional(),
  })
  .strict()

export const cliDeviceCreateResponseSchema = z.object({
  data: z.object({
    deviceCode: z.string(),
    userCode: z.string(),
    verificationUri: z.string(),
    verificationUriComplete: z.string(),
    expiresIn: z.number().int().positive(),
    interval: z.number().int().positive(),
  }),
})

export const cliDeviceTokenBodySchema = z
  .object({
    deviceCode: z.string().min(1).max(128),
  })
  .strict()

export const cliDeviceTokenResponseSchema = z.object({
  data: cliTokenPairSchema.extend({
    userId: z.uuid(),
    sessionId: z.uuid(),
    scope: z.literal('user'),
    isPlatformOperator: z.boolean(),
  }),
})

export const cliOrgExchangeBodySchema = z
  .object({
    organizationId: z.uuid(),
  })
  .strict()

export const cliUserSessionRevokeResponseSchema = z.object({
  data: z.object({ revoked: z.boolean() }),
})

export const cliOrgCredentialResponseSchema = z.object({
  data: z.object({
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().positive(),
    userId: z.uuid(),
    orgId: z.uuid(),
    orgRole: z.enum(['owner', 'admin', 'member', 'viewer']),
    sessionId: z.uuid(),
    scope: z.literal('org'),
    isPlatformOperator: z.boolean(),
  }),
})

export const cliDeviceDecisionBodySchema = z
  .object({
    userCode: z.string().min(1).max(32),
    decision: z.enum(['approve', 'deny']),
    totpCode: z.string().trim().min(1).max(12).optional(),
  })
  .strict()

export const cliDeviceDecisionResponseSchema = z.object({
  data: z.object({
    status: z.enum(['approved', 'denied']),
    expiresIn: z.number().int().nonnegative().optional(),
  }),
})
