import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { load } from './+page.server.js'

describe('project new-machine-user +page.server.ts', () => {
  it('returns the projectId and the caller org role', async () => {
    const result = await load({
      params: { projectId: 'proj-1' },
      locals: { user: { orgRole: 'owner' } },
    } as never)

    expect(result).toEqual({ projectId: 'proj-1', orgRole: 'owner' })
  })
})
