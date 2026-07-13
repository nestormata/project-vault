import { describe, expect, it, vi } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { requirePlatformOperator } from './require-platform-operator.js'

function mockReply() {
  const send = vi.fn()
  const status = vi.fn().mockReturnValue({ send })
  return { status, send, mock: { status, send } }
}

describe('requirePlatformOperator (Story 9.1 D1)', () => {
  it('sends 401 access_token_missing when there is no auth context', async () => {
    const request = {} as FastifyRequest
    const reply = mockReply()

    await requirePlatformOperator()(request, reply as unknown as FastifyReply)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'access_token_missing',
      message: 'Access token is missing',
    })
  })

  it('sends 403 platform_operator_required when the auth context lacks the flag', async () => {
    const request = {
      authContext: { isPlatformOperator: false },
    } as unknown as FastifyRequest
    const reply = mockReply()

    await requirePlatformOperator()(request, reply as unknown as FastifyReply)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'platform_operator_required',
      message: 'This endpoint requires platform operator privileges.',
    })
  })

  it('allows the request through when the auth context has isPlatformOperator', async () => {
    const request = {
      authContext: { isPlatformOperator: true },
    } as unknown as FastifyRequest
    const reply = mockReply()

    const result = await requirePlatformOperator()(request, reply as unknown as FastifyReply)

    expect(result).toBeUndefined()
    expect(reply.status).not.toHaveBeenCalled()
  })
})
