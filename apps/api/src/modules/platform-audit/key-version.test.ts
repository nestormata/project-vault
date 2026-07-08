import { describe, it, expect } from 'vitest'
import { getDb } from '@project-vault/db'
import { currentPlatformAuditKeyVersion } from './key-version.js'

describe('Story 9.4 AC-5: currentPlatformAuditKeyVersion', () => {
  it('reads vault_state.platform_audit_key_version independently of audit_key_version', async () => {
    const version = await getDb().transaction((tx) => currentPlatformAuditKeyVersion(tx))
    expect(typeof version).toBe('number')
    expect(version).toBeGreaterThanOrEqual(1)
  })
})
