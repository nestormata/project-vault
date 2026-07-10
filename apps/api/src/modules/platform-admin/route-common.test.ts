import { describe, expect, it, vi } from 'vitest'
import type { FastifyReply } from 'fastify'
import { SameTransactionPlatformAuditWriteError } from '../../lib/audit-or-fail-closed.js'
import { sendPlatformAuditWriteFailure } from './route-common.js'

describe('Story 9.8 platform-admin audit failure response', () => {
  it('maps a platform-audit write failure to the documented 503 response', () => {
    const send = vi.fn()
    const status = vi.fn(() => ({ send }))
    const reply = { status } as unknown as FastifyReply

    expect(
      sendPlatformAuditWriteFailure(
        new SameTransactionPlatformAuditWriteError('constraint failed'),
        reply
      )
    ).toBe(true)
    expect(status).toHaveBeenCalledWith(503)
    expect(send).toHaveBeenCalledWith({
      code: 'platform_audit_write_failed',
      message: 'Platform audit logging is unavailable',
    })
  })

  it('does not consume unrelated errors', () => {
    const reply = { status: vi.fn() } as unknown as FastifyReply

    expect(sendPlatformAuditWriteFailure(new Error('boom'), reply)).toBe(false)
    expect(reply.status).not.toHaveBeenCalled()
  })
})
