import { describe, expect, it } from 'vitest'
import { isLockNotAvailable, isUniqueViolation } from './db-helpers.js'

describe('isUniqueViolation', () => {
  it('returns false when the error has no cause, or a non-object cause', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
    expect(isUniqueViolation('not an error')).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })

  it('returns false for a cause whose code is not 23505', () => {
    const error = new Error('boom')
    ;(error as unknown as { cause: unknown }).cause = { code: '55P03' }
    expect(isUniqueViolation(error)).toBe(false)
  })

  it('returns true for a 23505 unique-violation cause', () => {
    const error = new Error('boom')
    ;(error as unknown as { cause: unknown }).cause = { code: '23505' }
    expect(isUniqueViolation(error)).toBe(true)
  })
})

describe('isLockNotAvailable', () => {
  it('returns false when the error has no cause, or a non-object cause', () => {
    expect(isLockNotAvailable(new Error('boom'))).toBe(false)
    expect(isLockNotAvailable('not an error')).toBe(false)
    expect(isLockNotAvailable(undefined)).toBe(false)
  })

  it('returns false for a cause whose code is not 55P03', () => {
    const error = new Error('boom')
    ;(error as unknown as { cause: unknown }).cause = { code: '23505' }
    expect(isLockNotAvailable(error)).toBe(false)
  })

  it('returns true for a 55P03 lock_not_available cause (Story 5.3 AC-5/AC-6)', () => {
    const error = new Error('boom')
    ;(error as unknown as { cause: unknown }).cause = { code: '55P03' }
    expect(isLockNotAvailable(error)).toBe(true)
  })
})
