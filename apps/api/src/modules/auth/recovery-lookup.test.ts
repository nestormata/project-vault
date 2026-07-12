import { describe, expect, it } from 'vitest'
import type { AccountRecoveryToken } from '@project-vault/db/schema'
import { validateRecoveryTokenStatus } from './recovery-lookup.js'

const FUTURE = new Date(Date.now() + 60 * 60 * 1000)
const PAST = new Date(Date.now() - 60 * 60 * 1000)

function baseToken(overrides: Partial<AccountRecoveryToken> = {}): AccountRecoveryToken {
  return {
    id: 'token-1',
    userId: 'user-1',
    tokenHash: 'hash',
    usedAt: null,
    supersededAt: null,
    expiresAt: FUTURE,
    createdAt: new Date(),
    ...overrides,
  } as AccountRecoveryToken
}

describe('validateRecoveryTokenStatus', () => {
  it('returns recovery_token_not_found (404) for a null token', () => {
    expect(validateRecoveryTokenStatus(null)).toEqual({
      code: 'recovery_token_not_found',
      message: 'Recovery link not found',
      statusCode: 404,
    })
  })

  it('returns recovery_token_used (409) when usedAt is set', () => {
    const result = validateRecoveryTokenStatus(baseToken({ usedAt: PAST }))
    expect(result).toMatchObject({ code: 'recovery_token_used', statusCode: 409 })
  })

  it('returns recovery_token_superseded (410) when supersededAt is set', () => {
    const result = validateRecoveryTokenStatus(baseToken({ supersededAt: PAST }))
    expect(result).toMatchObject({ code: 'recovery_token_superseded', statusCode: 410 })
  })

  it('returns recovery_token_expired (410) when expiresAt is in the past', () => {
    const result = validateRecoveryTokenStatus(baseToken({ expiresAt: PAST }))
    expect(result).toMatchObject({ code: 'recovery_token_expired', statusCode: 410 })
  })

  it('returns null (valid) for an unused, non-superseded, non-expired token', () => {
    expect(validateRecoveryTokenStatus(baseToken())).toBeNull()
  })

  it('checks used before superseded before expired, in that priority order', () => {
    const usedAndSuperseded = baseToken({ usedAt: PAST, supersededAt: PAST })
    expect(validateRecoveryTokenStatus(usedAndSuperseded)?.code).toBe('recovery_token_used')

    const supersededAndExpired = baseToken({ supersededAt: PAST, expiresAt: PAST })
    expect(validateRecoveryTokenStatus(supersededAndExpired)?.code).toBe(
      'recovery_token_superseded'
    )
  })
})
