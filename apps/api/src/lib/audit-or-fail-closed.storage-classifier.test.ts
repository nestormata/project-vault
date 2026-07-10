import { describe, expect, it } from 'vitest'
import { VaultSealedError } from '../modules/vault/key-service.js'
import { isPlatformAuditStorageUnavailableError } from './audit-or-fail-closed.js'

function errorWithCauseCode(code: string): Error {
  return Object.assign(new Error('query failed'), {
    cause: Object.assign(new Error('driver failed'), { code }),
  })
}

describe('Story 9.8 AC-T1: platform audit storage-unavailability classification', () => {
  it('classifies a sealed vault as storage unavailable', () => {
    expect(isPlatformAuditStorageUnavailableError(new VaultSealedError('sealed'))).toBe(true)
  })

  it.each(['08000', '08006', '53100', '53200', '53300', '57P01', '57P02', '57P03'])(
    'classifies Postgres storage-unavailability SQLSTATE %s',
    (code) => {
      expect(isPlatformAuditStorageUnavailableError(errorWithCauseCode(code))).toBe(true)
    }
  )

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE'])(
    'classifies socket error %s',
    (code) => {
      expect(isPlatformAuditStorageUnavailableError(errorWithCauseCode(code))).toBe(true)
    }
  )

  it('checks a code on the error itself', () => {
    const error = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
    expect(isPlatformAuditStorageUnavailableError(error)).toBe(true)
  })

  it.each([
    new Error('boom'),
    errorWithCauseCode('23503'),
    errorWithCauseCode('57014'),
    Object.assign(new Error('query failed'), { code: 8006 }),
    null,
    'ECONNREFUSED',
  ])('rejects non-storage error %#', (error) => {
    expect(isPlatformAuditStorageUnavailableError(error)).toBe(false)
  })
})
