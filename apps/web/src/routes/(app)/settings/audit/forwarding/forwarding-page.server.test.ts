import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: vi.fn(),
}))

import { requireUser } from '$lib/server/require-user.js'
import { load } from './+page.server.js'

const requireUserMock = vi.mocked(requireUser)

function makeEvent() {
  return {
    fetch: vi.fn(),
    url: new URL('http://localhost/settings/audit/forwarding'),
    locals: {},
  } as unknown as Parameters<typeof load>[0]
}

// AC-N1 — this page's gate is admin+ (stricter than member/viewer, looser than owner-only
// /settings/audit). No API call happens on load per D2 (no GET readback exists).
describe('/settings/audit/forwarding +page.server.ts', () => {
  beforeEach(() => requireUserMock.mockReset())

  it.each([
    { orgRole: 'owner', allowed: true },
    { orgRole: 'admin', allowed: true },
    { orgRole: 'member', allowed: false },
    { orgRole: 'viewer', allowed: false },
  ])('$allowed for orgRole=$orgRole', async ({ orgRole, allowed }) => {
    requireUserMock.mockReturnValue({ orgRole, orgId: 'org-1' } as ReturnType<typeof requireUser>)
    const result = await load(makeEvent())
    expect(result.allowed).toBe(allowed)
  })
})
