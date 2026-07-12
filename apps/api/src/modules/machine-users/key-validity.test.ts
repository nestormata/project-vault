import { describe, expect, it } from 'vitest'
import { isMachineKeyLive } from './key-validity.js'

const NOW = new Date('2026-01-01T00:00:00Z')

describe('isMachineKeyLive', () => {
  it('is live when revoked/expired/deactivated are all null', () => {
    expect(
      isMachineKeyLive({ revokedAt: null, expiresAt: null, machineUserDeactivatedAt: null }, NOW)
    ).toBe(true)
  })

  it('is not live once revoked', () => {
    expect(
      isMachineKeyLive({ revokedAt: NOW, expiresAt: null, machineUserDeactivatedAt: null }, NOW)
    ).toBe(false)
  })

  it('is not live once its owning machine user is deactivated', () => {
    expect(
      isMachineKeyLive({ revokedAt: null, expiresAt: null, machineUserDeactivatedAt: NOW }, NOW)
    ).toBe(false)
  })

  it('is not live once expired (expiresAt <= now)', () => {
    expect(
      isMachineKeyLive({ revokedAt: null, expiresAt: NOW, machineUserDeactivatedAt: null }, NOW)
    ).toBe(false)
  })

  it('is live when expiresAt is in the future', () => {
    const future = new Date(NOW.getTime() + 60_000)
    expect(
      isMachineKeyLive({ revokedAt: null, expiresAt: future, machineUserDeactivatedAt: null }, NOW)
    ).toBe(true)
  })
})
