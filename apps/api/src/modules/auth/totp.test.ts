import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as OTPAuth from 'otpauth'

let totpHelpers: typeof import('./totp.js')

function tokenForSecret(base32: string, timestamp = Date.now()): string {
  const totp = new OTPAuth.TOTP({
    issuer: 'Project Vault',
    label: 'user@example.com',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32),
  })
  return totp.generate({ timestamp })
}

describe('totp helpers', () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://vault_app:secret@localhost:5432/project_vault')
    totpHelpers = await import('./totp.js')
  })

  it('generates 160-bit base32 TOTP secrets', () => {
    const secret = totpHelpers.generateSecret()

    expect(secret.base32).toMatch(/^[A-Z2-7]+$/)
    expect(Buffer.from(secret.buffer).byteLength).toBe(20)
  })

  it('validates current and adjacent-window TOTP codes', () => {
    const secret = totpHelpers.generateSecret()
    const now = Date.now()
    const current = tokenForSecret(secret.base32, now)
    const previous = tokenForSecret(secret.base32, now - 30_000)

    expect(
      totpHelpers.validateTotpCode(secret.base32, current, { window: 1, timestamp: now }).valid
    ).toBe(true)
    expect(
      totpHelpers.validateTotpCode(secret.base32, previous, { window: 1, timestamp: now }).valid
    ).toBe(true)
    expect(
      totpHelpers.validateTotpCode(secret.base32, '000000', { window: 1, timestamp: now }).valid
    ).toBe(false)
  })

  it('creates stable replay hashes without exposing raw TOTP digits', () => {
    const hash = totpHelpers.createTotpReplayHash('user-1', 1234, '123456', 's'.repeat(32))

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(totpHelpers.createTotpReplayHash('user-1', 1234, '123456', 's'.repeat(32)))
    expect(hash).not.toContain('123456')
  })
})
