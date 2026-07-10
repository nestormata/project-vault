import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isRedirect } from '@sveltejs/kit'

const getVaultReadinessMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/vault.js', () => ({
  getVaultReadiness: getVaultReadinessMock,
}))

import { load } from './+page.server.js'

function makeEvent(user: unknown = null) {
  return { fetch: vi.fn(), locals: { user } } as unknown as Parameters<typeof load>[0]
}

describe('/vault +page.server.ts', () => {
  beforeEach(() => {
    getVaultReadinessMock.mockReset()
  })

  it('returns the readiness data when the vault is not ready', async () => {
    getVaultReadinessMock.mockResolvedValue({ state: 'sealed', message: 'Manual unseal required.' })

    const result = await load(makeEvent())

    expect(result).toEqual({ readiness: { state: 'sealed', message: 'Manual unseal required.' } })
  })

  it('redirects to /dashboard when ready and a user is present', async () => {
    getVaultReadinessMock.mockResolvedValue({ state: 'ready' })

    let caught: unknown
    try {
      await load(makeEvent({ id: 'u1' }))
    } catch (error) {
      caught = error
    }

    expect(isRedirect(caught)).toBe(true)
    expect((caught as { status: number; location: string }).status).toBe(303)
    expect((caught as { location: string }).location).toBe('/dashboard')
  })

  it('redirects to /login when ready and no user is present', async () => {
    getVaultReadinessMock.mockResolvedValue({ state: 'ready' })

    let caught: unknown
    try {
      await load(makeEvent(null))
    } catch (error) {
      caught = error
    }

    expect(isRedirect(caught)).toBe(true)
    expect((caught as { location: string }).location).toBe('/login')
  })
})
