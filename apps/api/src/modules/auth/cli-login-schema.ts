import { z } from 'zod/v4'

// Story 43.2 (Dev Notes decision #2) — new JSON-bearer-token login endpoints, mirroring
// `machine-users/token-exchange-schema.ts`'s response shape rather than the existing cookie-based
// `/login`/`/mfa/verify-login` routes. Reuses `LoginRequestSchema`/`mfaVerifyLoginBodySchema`
// (the request bodies are identical — only the *reply* carries tokens instead of `Set-Cookie`).

export { LoginRequestSchema } from '@project-vault/shared'

export const cliBearerSessionDataSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  userId: z.uuid(),
  orgId: z.uuid(),
})

export const cliMfaChallengeDataSchema = z.object({
  mfaRequired: z.literal(true),
  mfaToken: z.string(),
})

export const cliLoginResponseSchema = z.union([
  z.object({ data: cliBearerSessionDataSchema }),
  z.object({ data: cliMfaChallengeDataSchema }),
])

export { mfaVerifyLoginBodySchema as cliMfaVerifyLoginBodySchema } from './schema.js'
export const cliMfaVerifyLoginResponseSchema = z.object({ data: cliBearerSessionDataSchema })

export const cliRefreshBodySchema = z.object({ refreshToken: z.string().min(1).max(128) })
export const cliRefreshResponseSchema = z.object({
  data: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().positive(),
  }),
})

export const cliLogoutBodySchema = z.object({
  refreshToken: z.string().min(1).max(128).optional(),
})
export const cliLogoutResponseSchema = z.object({ data: z.object({ revoked: z.boolean() }) })
