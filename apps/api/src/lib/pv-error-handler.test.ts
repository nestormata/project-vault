import { describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'

const writeHandoffSecurityEvent = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../modules/auth/handoff-security-events.js', () => ({ writeHandoffSecurityEvent }))

const { pvErrorHandler } = await import('./pv-error-handler.js')
const { AppError } = await import('./errors.js')

/**
 * Story 68.14 Task 1.4 — goldens for PV's root error handler, written BEFORE it was extracted from
 * `createApp()` into a named function, so the extraction is provably behaviour-preserving. Every
 * branch is pinned: `AppError`, the two 429 shapes, the MFA and handoff parser normalizations, the
 * statusCode passthrough and the unhandled 500.
 */

const TEST_IP = '203.0.113.9'

type Sent = { status: number; body: unknown }

function fakeReply() {
  const sent: Sent[] = []
  const reply = {
    status: (status: number) => ({
      send: (body: unknown) => {
        sent.push({ status, body })
        return reply
      },
    }),
  }
  return { reply, sent }
}

function fakeRequest(url: string, headers: Record<string, string> = {}) {
  const error = vi.fn()
  return { req: { url, ip: TEST_IP, headers, log: { error } }, error }
}

type HandlerArgs = Parameters<typeof pvErrorHandler>
const URL_X = '/x'
const run = (error: Error, url: string, headers?: Record<string, string>) => {
  const { reply, sent } = fakeReply()
  const { req, error: logError } = fakeRequest(url, headers)
  const result = pvErrorHandler(error as HandlerArgs[0], req as never, reply as never)
  return { result, sent, logError }
}

describe('pvErrorHandler goldens (Story 68.14 Task 1.4)', () => {
  it('maps an AppError to its status and a lowercased code', async () => {
    const { result, sent } = run(new AppError('UNSEAL_FAILED', 'nope', 409), URL_X)
    await result
    expect(sent).toEqual([{ status: 409, body: { error: 'unseal_failed', message: 'nope' } }])
  })

  it('passes a route-scoped 429 { code, message } through unchanged', async () => {
    const error = Object.assign(new Error('slow down'), {
      statusCode: 429,
      code: 'rate_limit_exceeded',
    })
    const { result, sent } = run(error, URL_X)
    await result
    expect(sent).toEqual([
      { status: 429, body: { code: 'rate_limit_exceeded', message: 'slow down' } },
    ])
  })

  it('maps a bare 429 to the rate_limited shape with retryAfter in seconds', async () => {
    const error = Object.assign(new Error('x'), { statusCode: 429, ttl: 4500 })
    const { result, sent } = run(error, URL_X)
    await result
    expect(sent).toEqual([
      {
        status: 429,
        body: { error: 'rate_limited', message: 'Too many unseal attempts', retryAfter: 5 },
      },
    ])
  })

  it('leaves retryAfter undefined for a bare 429 without ttl', async () => {
    const { result, sent } = run(Object.assign(new Error('x'), { statusCode: 429 }), URL_X)
    await result
    expect(sent[0]?.body).toEqual({
      error: 'rate_limited',
      message: 'Too many unseal attempts',
      retryAfter: undefined,
    })
  })

  it.each([
    [413, undefined],
    [415, undefined],
    [400, 'FST_ERR_CTP_BODY_TOO_LARGE'],
    [400, 'FST_ERR_CTP_INVALID_MEDIA_TYPE'],
  ])('normalizes the MFA verify-login parser error (%s, %s) to 422', async (statusCode, code) => {
    const error = Object.assign(new Error('parser'), { statusCode, code })
    const { result, sent } = run(error, '/api/v1/auth/mfa/verify-login?x=1')
    await result
    expect(sent).toEqual([
      {
        status: 422,
        body: { code: 'validation_error', message: 'Request validation failed' },
      },
    ])
  })

  it('normalizes an oversized handoff prepare body to 401 and records the security event', async () => {
    const error = Object.assign(new Error('too big'), { statusCode: 413 })
    const { reply, sent } = fakeReply()
    const { req } = fakeRequest('/api/v1/auth/handoff/prepare', { 'user-agent': 'cm-test' })
    await pvErrorHandler(error as HandlerArgs[0], req as never, reply as never)
    expect(sent).toEqual([
      {
        status: 401,
        body: {
          code: 'handoff_rejected',
          message: 'Sign-in could not be verified. Please start again.',
        },
      },
    ])
    expect(writeHandoffSecurityEvent).toHaveBeenCalledWith({
      eventType: 'handoff_claims_oversized',
      meta: { ipAddress: TEST_IP, userAgent: 'cm-test' },
    })
  })

  it('records a null user agent for a handoff parser error without the header', async () => {
    writeHandoffSecurityEvent.mockClear()
    const error = Object.assign(new Error('too big'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE' })
    const { result } = run(error, '/api/v1/auth/handoff/prepare')
    await result
    expect(writeHandoffSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { ipAddress: TEST_IP, userAgent: null } })
    )
  })

  it('maps any other numeric statusCode to the validation_error shape', async () => {
    const { result, sent } = run(Object.assign(new Error('bad body'), { statusCode: 400 }), URL_X)
    await result
    expect(sent).toEqual([
      { status: 400, body: { error: 'validation_error', message: 'bad body' } },
    ])
  })

  it('logs and answers an unhandled error with a generic 500', async () => {
    const { result, sent, logError } = run(new Error('secret detail'), URL_X)
    await result
    expect(sent).toEqual([
      {
        status: 500,
        body: { error: 'internal_error', message: 'An unexpected error occurred' },
      },
    ])
    expect(logError).toHaveBeenCalledOnce()
    const [fields, message] = logError.mock.calls[0] as [Record<string, unknown>, string]
    expect(fields['eventType']).toBe(OperationalEvent.HTTP_REQUEST_FAILED)
    expect(message).toBe('Unhandled request error')
  })
})
