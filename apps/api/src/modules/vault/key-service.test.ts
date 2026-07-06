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

describe('getAuditKey', () => {
  // Adversarial-review finding (Story 8.1 code review): apps/api/src/modules/audit/routes.ts
  // originally detected a sealed vault by matching getAuditKey()'s thrown Error#message against a
  // hardcoded string literal duplicated in that file. If this message text ever drifted, the
  // match would silently fail and AC-10's required `503 audit_key_unavailable` would degrade to
  // an unhandled 500 with no compiler/test signal at the drift site. A typed error class removes
  // that duplication — callers match by `instanceof`, not by re-typing the message elsewhere.
  it('throws a VaultSealedError instance (not a bare Error) when the vault is sealed/uninitialized', async () => {
    const { getAuditKey, VaultSealedError } = await import('./key-service.js')

    let caught: unknown
    try {
      getAuditKey()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(VaultSealedError)
  })
})
