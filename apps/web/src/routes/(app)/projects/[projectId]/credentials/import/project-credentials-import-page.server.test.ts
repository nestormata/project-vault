import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: (locals: { user: { orgRole: string } }) => locals.user,
}))

import { load } from './+page.server.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeEvent(orgRole: string) {
  return {
    params: { projectId },
    locals: { user: { orgRole } },
  } as unknown as Parameters<typeof load>[0]
}

describe('project credentials import +page.server.ts', () => {
  it('an owner can import', async () => {
    const result = await load(makeEvent('owner'))
    expect(result.canImport).toBe(true)
  })

  it('an admin can import', async () => {
    const result = await load(makeEvent('admin'))
    expect(result.canImport).toBe(true)
  })

  it('a member cannot import', async () => {
    const result = await load(makeEvent('member'))
    expect(result.canImport).toBe(false)
  })
})
