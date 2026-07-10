import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: unknown }) => locals.user,
}))

import { load } from './+page.server.js'

describe('/settings/security +page.server.ts', () => {
  it('returns the authenticated user from requireUser', () => {
    const user = { orgRole: 'owner' }
    const result = load({ locals: { user } } as never)
    expect(result).toEqual({ user })
  })
})
