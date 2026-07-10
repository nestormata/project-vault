import { describe, expect, it, vi } from 'vitest'
import { isRedirect } from '@sveltejs/kit'

const getVaultReadinessMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/vault.js', () => ({
  getVaultReadiness: getVaultReadinessMock,
}))

import { load } from './+page.server.js'

function makeEvent(user: unknown = null) {
  return { fetch: vi.fn(), locals: { user } } as unknown as Parameters<typeof load>[0]
}

async function loadRedirect(event: Parameters<typeof load>[0]) {
  try {
    await load(event)
    throw new Error('expected a redirect to be thrown')
  } catch (error) {
    if (!isRedirect(error)) throw error
    return error
  }
}

describe('root /+page.server.ts routing', () => {
  it('redirects to /vault when the vault is not ready', async () => {
    getVaultReadinessMock.mockResolvedValue({ state: 'sealed' })
    const redirect = await loadRedirect(makeEvent())
    expect(redirect.status).toBe(303)
    expect(redirect.location).toBe('/vault')
  })

  it('redirects an authenticated user to /dashboard when the vault is ready', async () => {
    getVaultReadinessMock.mockResolvedValue({ state: 'ready' })
    const redirect = await loadRedirect(makeEvent({ id: 'user-1' }))
    expect(redirect.status).toBe(303)
    expect(redirect.location).toBe('/dashboard')
  })

  it('redirects an anonymous user to /login when the vault is ready', async () => {
    getVaultReadinessMock.mockResolvedValue({ state: 'ready' })
    const redirect = await loadRedirect(makeEvent(null))
    expect(redirect.status).toBe(303)
    expect(redirect.location).toBe('/login')
  })
})
