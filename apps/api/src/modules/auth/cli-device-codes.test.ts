import { describe, expect, it } from 'vitest'
import {
  CLI_DEVICE_USER_CODE_ALPHABET,
  deviceCodeHashesEqual,
  formatUserCode,
  generateDeviceCode,
  generateUserCode,
  hashUserCode,
  isDeviceCodeShape,
  normalizeUserCode,
} from './cli-device-codes.js'

describe('CLI device codes (Story 43.30)', () => {
  it('normalizes a displayed code and rejects anything else', () => {
    expect(normalizeUserCode('abcd-efgh')).toBeNull()
    expect(normalizeUserCode('BCDF-GHJK')).toBe('BCDFGHJK')
    expect(normalizeUserCode('bcdf ghjk')).toBe('BCDFGHJK')
    expect(normalizeUserCode('BCDFGHJK')).toBe('BCDFGHJK')
    expect(normalizeUserCode('BCDF-GHJ0')).toBeNull()
    expect(normalizeUserCode('BCDF-GHJ')).toBeNull()
    expect(formatUserCode('BCDFGHJK')).toBe('BCDF-GHJK')
  })

  it('draws the user code from the unambiguous alphabet and a 32-byte device code', () => {
    const userCode = generateUserCode()
    expect(userCode).toHaveLength(8)
    for (const char of userCode) expect(CLI_DEVICE_USER_CODE_ALPHABET.includes(char)).toBe(true)
    const deviceCode = generateDeviceCode()
    expect(isDeviceCodeShape(deviceCode)).toBe(true)
    expect(generateDeviceCode()).not.toBe(deviceCode)
  })

  it('compares hashes in constant time and still compares when the stored hash is missing', () => {
    const hash = hashUserCode('BCDFGHJK')
    expect(deviceCodeHashesEqual(hash, hash)).toBe(true)
    expect(deviceCodeHashesEqual(hash, hashUserCode('BCDFGHJL'))).toBe(false)
    expect(deviceCodeHashesEqual(undefined, hash)).toBe(false)
    expect(deviceCodeHashesEqual('aa', hash)).toBe(false)
  })
})
