import { describe, it, expect } from 'vitest'
import { SecretValue, withSecret } from './index.js'
import type { EncryptedValue } from './index.js'

describe('SecretValue', () => {
  it('redacts in toString', () => {
    const secret = new SecretValue('my-secret')
    expect(secret.toString()).toBe('[REDACTED]')
  })

  it('redacts in JSON serialization', () => {
    const secret = new SecretValue('my-secret')
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}')
  })

  it('allows use via callback', () => {
    const secret = new SecretValue('my-secret')
    const result = secret.use((v) => v.toUpperCase())
    expect(result).toBe('MY-SECRET')
  })
})

describe('withSecret stub', () => {
  it('throws because it is not implemented', async () => {
    const encrypted: EncryptedValue = {
      version: 1,
      iv: 'test-iv',
      ciphertext: 'test-ciphertext',
      tag: 'test-tag',
    }
    await expect(withSecret(encrypted, async () => 'result')).rejects.toThrow(
      'withSecret is not implemented until Story 1.5'
    )
  })
})
