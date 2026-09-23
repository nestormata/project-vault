import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { refreshTokens } from '@project-vault/db/schema'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { ApiErrorSchema, withRouteTypeProvider } from '../../lib/api-contracts.js'
import { validationError } from '../../lib/route-helpers.js'
import { revokeSessionById } from './session-revoke.js'
import { refreshSession, type LoginResult } from './service.js'
import { verifyLogin } from './mfa-login.js'
import { buildCookieTokens, hashRefreshToken, type JwtSigner } from './tokens.js'
import {
  handleGatedLogin,
  metaFromRequest,
  registerMethodNotAllowed,
  rejectIfNativeLoginDisabled,
} from './routes.js'
import {
  LoginRequestSchema,
  cliLoginResponseSchema,
  cliLogoutBodySchema,
  cliLogoutResponseSchema,
  cliMfaVerifyLoginBodySchema,
  cliMfaVerifyLoginResponseSchema,
  cliRefreshBodySchema,
  cliRefreshResponseSchema,
} from './cli-login-schema.js'

// Story 43.2 (Dev Notes decision #2) — dedicated CLI-facing login/refresh/logout routes,
// mirroring `machine-users/token-exchange-routes.ts`'s JSON-bearer-token shape. These call the
// exact same `loginUser()`/`verifyLogin()`/`refreshSession()` functions the cookie-based routes
// in routes.ts use (no duplicated auth logic) — only the reply shape differs (JSON body instead
// of `Set-Cookie`). Kept in this own file rather than a mode flag on `/login`, per this story's
// Dev Notes: a header-gated dual-mode route is a subtler, easier-to-regress surface (a missing
// header silently falls back to cookie mode) than two explicitly separate, testable routes.

function sendAppError(reply: FastifyReply, error: AppError): unknown {
  return reply.status(error.statusCode).send({ code: error.code, message: error.message })
}

async function sendBearerSession(
  fastify: FastifyApp,
  reply: FastifyReply,
  result: LoginResult
): Promise<unknown> {
  const built = await buildCookieTokens(fastify as unknown as JwtSigner, result.tokens)
  if (!built.refreshOpaque) {
    // Never reachable in practice — createLoginSessionInTx()/rotateRefreshToken() always mint a
    // refresh token for a human login/refresh — but fail loudly rather than silently omitting the
    // refresh token from a CLI session the caller would then be unable to ever refresh.
    throw new AppError(
      'service_unavailable',
      'Session issuance did not produce a refresh token',
      503
    )
  }
  return reply.send({
    data: {
      accessToken: built.accessJwt,
      refreshToken: built.refreshOpaque,
      tokenType: 'Bearer' as const,
      expiresIn: built.accessMaxAgeSec,
      userId: result.userId,
      orgId: result.orgId,
    },
  })
}

export async function cliLoginRoutes(fastify: FastifyApp): Promise<void> {
  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli-login',
    bodyLimit: 4096,
    attachValidation: true,
    schema: {
      body: LoginRequestSchema,
      response: {
        200: cliLoginResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handleGatedLogin(
          req,
          reply,
          (reply, result) => reply.send({ data: result }),
          (result) => sendBearerSession(fastify, reply, result)
        )
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli/mfa/verify-login',
    bodyLimit: 4096,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    attachValidation: true,
    schema: {
      body: cliMfaVerifyLoginBodySchema,
      response: {
        200: cliMfaVerifyLoginResponseSchema,
        401: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const gated = rejectIfNativeLoginDisabled(reply)
      if (gated !== null) return gated
      const parsed = cliMfaVerifyLoginBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      try {
        const result = await verifyLogin(parsed.data, metaFromRequest(req))
        return sendBearerSession(fastify, reply, result)
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli/refresh',
    bodyLimit: 4096,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    attachValidation: true,
    schema: {
      body: cliRefreshBodySchema,
      response: {
        200: cliRefreshResponseSchema,
        401: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = cliRefreshBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      try {
        const result = await refreshSession(parsed.data.refreshToken, metaFromRequest(req))
        const built = await buildCookieTokens(fastify as unknown as JwtSigner, result.tokens)
        if (!built.refreshOpaque) {
          throw new AppError(
            'service_unavailable',
            'Session refresh did not produce a refresh token',
            503
          )
        }
        return reply.send({
          data: {
            accessToken: built.accessJwt,
            refreshToken: built.refreshOpaque,
            tokenType: 'Bearer' as const,
            expiresIn: built.accessMaxAgeSec,
          },
        })
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli/logout',
    bodyLimit: 4096,
    attachValidation: true,
    schema: {
      body: cliLogoutBodySchema,
      response: {
        200: cliLogoutResponseSchema,
        422: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = cliLogoutBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      const refreshToken = parsed.data.refreshToken
      // AC-6: purely best-effort — a missing/already-dead/unrecognized token is not an error, it
      // just means there was nothing left to invalidate server-side; the CLI's local file
      // deletion (session-store.ts's deleteSession()) is this command's actual primary job.
      if (!refreshToken) return reply.send({ data: { revoked: false } })
      try {
        const revoked = await revokeCliSession(refreshToken)
        return reply.send({ data: { revoked } })
      } catch {
        return reply.send({ data: { revoked: false } })
      }
    },
  })

  registerMethodNotAllowed(fastify, '/cli-login')
  registerMethodNotAllowed(fastify, '/cli/mfa/verify-login')
  registerMethodNotAllowed(fastify, '/cli/refresh')
  registerMethodNotAllowed(fastify, '/cli/logout')
}

async function revokeCliSession(refreshToken: string): Promise<boolean> {
  const tokenHash = hashRefreshToken(refreshToken)
  return getDb().transaction(async (tx) => {
    // Mirrors service.ts's findRefreshRow() staging: refreshTokens itself carries `orgId` and is
    // readable before any RLS org context is set (it's the entry point for establishing that
    // context), but `sessions` is org-scoped RLS — so this must NOT join the two tables in one
    // query before `revokeSessionById()`'s own `applyExpectedOrgContext()` runs, or the `sessions`
    // half of the join is silently RLS-filtered to zero rows.
    const tokenRows = await (tx as Tx)
      .select({ sessionId: refreshTokens.sessionId, orgId: refreshTokens.orgId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1)
    const tokenRow = tokenRows[0]
    if (!tokenRow) return false
    const result = await revokeSessionById(tokenRow.sessionId, {
      scope: 'logout',
      expectedOrgId: tokenRow.orgId,
      tx: tx as Tx,
    })
    return result.revoked
  })
}
