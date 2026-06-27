import { afterEach, describe, expect, it, vi } from 'vitest'

const limit = vi.fn()
const db = {
  select: vi.fn(() => ({
    from: () => ({
      limit,
    }),
  })),
}

vi.mock('@project-vault/db', () => ({
  getDb: () => db,
}))

vi.mock('../../config/env.js', () => ({
  env: {
    VAULT_KEY_DIR: '/run/secrets',
  },
}))

describe('loadInitialVaultState', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not write raw stderr when vault state cannot be loaded', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    limit.mockRejectedValueOnce(new Error('database unavailable'))
    const { loadInitialVaultState } = await import('./key-service.js')

    await expect(loadInitialVaultState()).rejects.toThrow('database unavailable')

    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})
