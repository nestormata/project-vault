import { describe, expect, it } from 'vitest'
import {
  LAST_SECOND_FACTOR_REQUIRED_MESSAGE,
  decideSignCount,
  lastFactorRemovalBlocked,
  parseAuthenticatorName,
  relyingPartyFromCors,
} from './webauthn-policy.js'

describe('decideSignCount', () => {
  it('accepts a counter that never increments (0 to 0)', () => {
    expect(decideSignCount(0, 0)).toEqual({ kind: 'accept', next: 0 })
  })

  it('accepts a strictly greater observed counter', () => {
    expect(decideSignCount(5, 6)).toEqual({ kind: 'accept', next: 6 })
  })

  it('treats an equal non-zero counter as cloned', () => {
    expect(decideSignCount(5, 5)).toEqual({ kind: 'cloned' })
  })

  it('treats a regression as cloned', () => {
    expect(decideSignCount(5, 3)).toEqual({ kind: 'cloned' })
  })
})

describe('lastFactorRemovalBlocked', () => {
  it('allows an owner to delete a key when TOTP or another key remains', () => {
    expect(lastFactorRemovalBlocked({ orgRole: 'owner', remainingAfterDelete: 1 })).toEqual({
      blocked: false,
    })
  })

  it('refuses an owner deleting the last remaining second factor and names the role requirement', () => {
    expect(lastFactorRemovalBlocked({ orgRole: 'owner', remainingAfterDelete: 0 })).toEqual({
      blocked: true,
      message: LAST_SECOND_FACTOR_REQUIRED_MESSAGE,
    })
    expect(LAST_SECOND_FACTOR_REQUIRED_MESSAGE).toMatch(/Owner and Admin MFA/)
  })

  it('refuses an admin deleting the last remaining second factor', () => {
    expect(lastFactorRemovalBlocked({ orgRole: 'admin', remainingAfterDelete: 0 }).blocked).toBe(
      true
    )
  })

  it('allows a member to delete their last remaining second factor', () => {
    expect(lastFactorRemovalBlocked({ orgRole: 'member', remainingAfterDelete: 0 })).toEqual({
      blocked: false,
    })
  })
})

describe('parseAuthenticatorName', () => {
  it('trims a valid name', () => {
    expect(parseAuthenticatorName('  Desk YubiKey  ')).toBe('Desk YubiKey')
  })

  it('rejects empty and over-long names', () => {
    expect(parseAuthenticatorName('')).toBeNull()
    expect(parseAuthenticatorName('   ')).toBeNull()
    expect(parseAuthenticatorName('x'.repeat(65))).toBeNull()
  })
})

describe('relyingPartyFromCors', () => {
  it('uses the hostname of the first CORS origin', () => {
    expect(relyingPartyFromCors('http://localhost:5173,https://app.example.com')).toEqual({
      rpID: 'localhost',
      origin: 'http://localhost:5173',
    })
  })
})
