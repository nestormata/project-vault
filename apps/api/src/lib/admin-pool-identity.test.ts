import { describe, expect, it, vi } from 'vitest'
import { inspectAdminPoolIdentity } from './admin-pool-identity.js'

describe('admin pool identity verification', () => {
  it.each([
    [{ current_user: 'vault_admin', rolsuper: false, rolbypassrls: true }, 'ok'],
    [{ current_user: 'postgres', rolsuper: true, rolbypassrls: true }, 'superuser'],
    [{ current_user: 'vault_admin', rolsuper: false, rolbypassrls: false }, 'no-bypassrls'],
  ] as const)('classifies %j as %s', async (row, status) => {
    const execute = vi.fn(async () => [row])
    await expect(inspectAdminPoolIdentity(execute)).resolves.toMatchObject({ status })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('classifies a failed query as unreachable without exposing driver details', async () => {
    const execute = vi.fn(async () => {
      throw new Error('password=secret host=example.invalid')
    })
    await expect(inspectAdminPoolIdentity(execute)).resolves.toEqual({ status: 'unreachable' })
  })

  it('classifies a missing role row as unreachable', async () => {
    await expect(inspectAdminPoolIdentity(async () => [])).resolves.toEqual({
      status: 'unreachable',
    })
  })
})
