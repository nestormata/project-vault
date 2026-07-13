import { describe, expect, it, vi } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { requireAuthContext, requireOrgRole } from './require-org-role.js'
import type { AuthContext } from './require-org-role.js'

function mockReply() {
  const send = vi.fn()
  const status = vi.fn().mockReturnValue({ send })
  return { status, send, mock: { status, send } }
}

const authContext: AuthContext = {
  userId: 'user-1',
  orgId: 'org-1',
  sessionId: 'session-1',
  jti: 'jti-1',
  sessionVersion: 1,
  orgRole: 'member',
  isPlatformOperator: false,
}

describe('requireAuthContext', () => {
  it('sends 401 access_token_missing and returns undefined when there is no auth context', () => {
    const request = {} as FastifyRequest
    const reply = mockReply()

    const result = requireAuthContext(request, reply as unknown as FastifyReply)

    expect(result).toBeUndefined()
    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'access_token_missing',
      message: 'Access token is missing',
    })
  })

  it('returns the auth context unchanged without sending a reply when present', () => {
    const request = { authContext } as unknown as FastifyRequest
    const reply = mockReply()

    const result = requireAuthContext(request, reply as unknown as FastifyReply)

    expect(result).toBe(authContext)
    expect(reply.status).not.toHaveBeenCalled()
  })
})

describe('requireOrgRole', () => {
  it('returns early without a second reply when there is no auth context', async () => {
    const request = {} as FastifyRequest
    const reply = mockReply()

    await requireOrgRole('owner')(request, reply as unknown as FastifyReply)

    expect(reply.status).toHaveBeenCalledTimes(1)
    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'access_token_missing',
      message: 'Access token is missing',
    })
  })

  it('sends 403 insufficient_role when the org role is not in the allowed list', async () => {
    const request = { authContext } as unknown as FastifyRequest
    const reply = mockReply()

    await requireOrgRole('owner', 'admin')(request, reply as unknown as FastifyReply)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'insufficient_role',
      message: 'Insufficient permissions',
    })
  })

  it('allows the request through when the org role is in the allowed list', async () => {
    const request = { authContext } as unknown as FastifyRequest
    const reply = mockReply()

    const result = await requireOrgRole('member', 'admin')(
      request,
      reply as unknown as FastifyReply
    )

    expect(result).toBeUndefined()
    expect(reply.status).not.toHaveBeenCalled()
  })
})
