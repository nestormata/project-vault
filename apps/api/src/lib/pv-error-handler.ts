import type { FastifyRequest } from 'fastify'
import { HandoffEvent, OperationalEvent } from '@project-vault/shared'
import { writeHandoffSecurityEvent } from '../modules/auth/handoff-security-events.js'
import { AppError } from './errors.js'
import { serializeLogError } from './logger.js'

function shouldNormalizeMfaParserError(
  url: string,
  statusCode: number | undefined,
  parserErrorCode: string | undefined
): boolean {
  const path = url.split('?')[0]
  return (
    path === '/api/v1/auth/mfa/verify-login' &&
    (statusCode === 413 ||
      statusCode === 415 ||
      parserErrorCode === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
      parserErrorCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
  )
}

const HANDOFF_GENERIC_REJECTION_MESSAGE = 'Sign-in could not be verified. Please start again.'

// Story 30.2 AC3.8: an oversized /auth/handoff/prepare body is rejected by Fastify's body
// parser (the route's own `bodyLimit: 16 * 1024`) BEFORE handlePrepare ever runs, so
// verifyHandoffToken's own MAX_HANDOFF_TOKEN_BYTES branch (which would emit
// handoff_claims_oversized) is unreachable for this case. Mirrors shouldNormalizeMfaParserError's
// precedent: normalize the parser-level 413 to the route's own generic rejection contract and
// still record the required security event.
function shouldNormalizeHandoffParserError(
  url: string,
  statusCode: number | undefined,
  parserErrorCode: string | undefined
): boolean {
  const path = url.split('?')[0]
  return (
    path === '/api/v1/auth/handoff/prepare' &&
    (statusCode === 413 || parserErrorCode === 'FST_ERR_CTP_BODY_TOO_LARGE')
  )
}

/** The reply surface PV's root error handler uses. */
type ErrorReply = { status: (code: number) => { send: (body: unknown) => unknown } }

/**
 * PV's root error handler (previously an inline arrow in `createApp()`; Story 68.14 extracted it,
 * unchanged, so an extension's `apiRoutes.app.errorHandler` can wrap it or fall back to it).
 */
export async function pvErrorHandler(
  error: Error & { statusCode?: number },
  req: FastifyRequest,
  reply: ErrorReply
): Promise<unknown> {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.code.toLowerCase(), // e.g. 'unseal_failed' — match epics snake_case convention
      message: error.message,
    })
  }
  // Rate-limit 429 errors from @fastify/rate-limit — map to canonical API shape (AC-24)
  if (error.statusCode === 429) {
    // Route-scoped rate limiters (e.g. authRoutes) build their own { code, message } body
    // via errorResponseBuilder — pass it through as-is instead of the vault-unseal default.
    const { code } = error as unknown as { code?: string }
    if (code) {
      return reply.status(429).send({ code, message: error.message })
    }
    return reply.status(429).send({
      error: 'rate_limited',
      message: 'Too many unseal attempts',
      retryAfter: (error as unknown as { ttl?: number }).ttl
        ? Math.ceil((error as unknown as { ttl: number }).ttl / 1000)
        : undefined,
    })
  }
  // Body parsing happens before route handlers run, so the MFA verify-login route cannot
  // use its normal Zod parser for Fastify's 413/415 errors. Normalize both to the route's
  // documented validation contract without exposing parser internals.
  const parserErrorCode = (error as Error & { code?: string }).code
  if (shouldNormalizeMfaParserError(req.url, error.statusCode, parserErrorCode)) {
    return reply.status(422).send({
      code: 'validation_error',
      message: 'Request validation failed',
    })
  }
  if (shouldNormalizeHandoffParserError(req.url, error.statusCode, parserErrorCode)) {
    await writeHandoffSecurityEvent({
      eventType: HandoffEvent.HANDOFF_CLAIMS_OVERSIZED,
      meta: {
        ipAddress: req.ip,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      },
    })
    return reply
      .status(401)
      .send({ code: 'handoff_rejected', message: HANDOFF_GENERIC_REJECTION_MESSAGE })
  }
  // Preserve Fastify/Zod validation errors (statusCode already set)
  if (typeof error.statusCode === 'number') {
    return reply.status(error.statusCode).send({
      error: 'validation_error',
      message: error.message,
    })
  }
  req.log.error(
    { eventType: OperationalEvent.HTTP_REQUEST_FAILED, err: serializeLogError(error) },
    'Unhandled request error'
  )
  return reply
    .status(500)
    .send({ error: 'internal_error', message: 'An unexpected error occurred' })
}
