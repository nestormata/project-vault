import { describe, it, expect } from 'vitest'
import {
  createKeyDerivationParams,
  deriveIkmFromPassphrase,
  hashUserPassword,
  passwordHashConfigFromEnv,
  validateKeyDerivationParams,
  verifyUserPassword,
} from './passwords.js'

const USER_PASSWORD = 'correct-horse-battery-staple'

describe('createKeyDerivationParams', () => {
  it('generates a 32-char hex salt and canonical argon2id params', () => {
    const params = createKeyDerivationParams()
    expect(params.type).toBe('argon2id')
    expect(params.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(params.memoryCost).toBe(65536)
    expect(params.timeCost).toBe(3)
    expect(params.parallelism).toBe(4)
  })

  it('generates distinct salts on each call', () => {
    const a = createKeyDerivationParams()
    const b = createKeyDerivationParams()
    expect(a.salt).not.toBe(b.salt)
  })
})

describe('deriveIkmFromPassphrase', () => {
  it('produces a 32-byte IKM buffer', async () => {
    const params = createKeyDerivationParams()
    const ikm = await deriveIkmFromPassphrase(USER_PASSWORD, params)
    expect(ikm.length).toBe(32)
  })

  it('is deterministic for the same passphrase + params', async () => {
    const params = createKeyDerivationParams()
    const ikm1 = await deriveIkmFromPassphrase('same-passphrase-12345', params)
    const ikm2 = await deriveIkmFromPassphrase('same-passphrase-12345', params)
    expect(ikm1.equals(ikm2)).toBe(true)
  })

  it('produces different IKM for different passphrases', async () => {
    const params = createKeyDerivationParams()
    const ikm1 = await deriveIkmFromPassphrase('passphrase-one-12345', params)
    const ikm2 = await deriveIkmFromPassphrase('passphrase-two-12345', params)
    expect(ikm1.equals(ikm2)).toBe(false)
  })

  it('rejects unsupported KDF type', async () => {
    const params = createKeyDerivationParams()
    await expect(
      deriveIkmFromPassphrase('x', { ...params, type: 'bogus' as 'argon2id' })
    ).rejects.toThrow(/unsupported type/)
  })
})

describe('validateKeyDerivationParams', () => {
  it('accepts canonical params', () => {
    expect(() => validateKeyDerivationParams(createKeyDerivationParams())).not.toThrow()
  })

  it('rejects memoryCost below minimum', () => {
    const params = { ...createKeyDerivationParams(), memoryCost: 1024 }
    expect(() => validateKeyDerivationParams(params)).toThrow(/memoryCost/)
  })

  it('rejects timeCost below minimum', () => {
    const params = { ...createKeyDerivationParams(), timeCost: 1 }
    expect(() => validateKeyDerivationParams(params)).toThrow(/timeCost/)
  })

  it('rejects parallelism out of range', () => {
    const params = { ...createKeyDerivationParams(), parallelism: 0 }
    expect(() => validateKeyDerivationParams(params)).toThrow(/parallelism/)
  })

  it('rejects invalid salt', () => {
    const params = { ...createKeyDerivationParams(), salt: 'not-hex' }
    expect(() => validateKeyDerivationParams(params)).toThrow(/salt/)
  })
})

describe('user password hashing', () => {
  const fastTestConfig = {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  }

  it('builds a runtime hash config from env-shaped values', () => {
    expect(passwordHashConfigFromEnv(fastTestConfig)).toEqual(fastTestConfig)
  })

  it('hashes user passwords as Argon2id PHC strings', async () => {
    const hash = await hashUserPassword(USER_PASSWORD, fastTestConfig)

    expect(hash).toMatch(/^\$argon2id\$/)
    expect(hash).toContain('m=19456,t=2,p=1')
  })

  it('verifies matching and non-matching user passwords', async () => {
    const hash = await hashUserPassword(USER_PASSWORD, fastTestConfig)

    await expect(verifyUserPassword(USER_PASSWORD, hash)).resolves.toBe(true)
    await expect(verifyUserPassword('wrong-password-12345', hash)).resolves.toBe(false)
  })
})
