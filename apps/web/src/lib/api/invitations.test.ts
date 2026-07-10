import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  peekInvitation,
  revokeInvitation,
} from './invitations.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('invitations API helpers', () => {
  it('createInvitation POSTs a JSON body (jsonPost with body defined)', async () => {
    const invitation = {
      id: 'inv-1',
      email: 'new@example.com',
      roleToAssign: 'member' as const,
      invitedBy: 'user-1',
      expiresAt: '2026-08-01T00:00:00.000Z',
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: invitation }, { status: 201 }))

    const result = await createInvitation(fetchFn, projectId, {
      email: 'new@example.com',
      role: 'member',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/invitations`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'new@example.com', role: 'member' }),
      })
    )
    expect(result).toEqual(invitation)
  })

  it('acceptInvitation POSTs with no body (jsonPost with body undefined)', async () => {
    const acceptResult = { projectId, projectName: 'Payments', role: 'member' as const }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: acceptResult }))

    const result = await acceptInvitation(fetchFn, 'tok en')

    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/v1/invitations/tok%20en/accept')
    expect(init).toEqual(expect.objectContaining({ method: 'POST', credentials: 'include' }))
    expect('body' in init).toBe(false)
    expect(result).toEqual(acceptResult)
  })

  it('listInvitations GETs the collection for a project', async () => {
    const invitations = [
      {
        id: 'inv-1',
        email: 'a@example.com',
        roleToAssign: 'viewer' as const,
        invitedBy: 'user-1',
        expiresAt: '2026-08-01T00:00:00.000Z',
      },
    ]
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: invitations }))

    const result = await listInvitations(fetchFn, projectId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/invitations`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual(invitations)
  })

  it('revokeInvitation DELETEs a specific invitation', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

    const result = await revokeInvitation(fetchFn, projectId, 'inv-1')

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/invitations/inv-1`,
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(result).toBeUndefined()
  })

  it('peekInvitation GETs and URL-encodes the token', async () => {
    const peek = {
      email: 'invited@example.com',
      projectName: 'Payments',
      role: 'admin' as const,
      accountExists: false,
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: peek }))

    const result = await peekInvitation(fetchFn, 'tok/en')

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/invitations/tok%2Fen',
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual(peek)
  })
})
