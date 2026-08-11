import { describe, expect, it } from 'vitest'
import { classifyStorageError } from './storage-errors.js'

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException
  error.code = code
  return error
}

const PATH = '/var/backups/vault'

describe('Story 9.9 AC-4: classifyStorageError', () => {
  it.each(['EACCES', 'EPERM'])(
    '%s classifies as "permission" and mentions the required uid/gid and runbook',
    (code) => {
      const { category, message } = classifyStorageError(errnoError(code), PATH)
      expect(category).toBe('permission')
      expect(message).toMatch(/1000:1000/)
      expect(message).toMatch(/runbook/)
      expect(message).toContain(PATH)
    }
  )

  it.each(['ENOSPC', 'EDQUOT'])('%s classifies as "full"', (code) => {
    const { category, message } = classifyStorageError(errnoError(code), PATH)
    expect(category).toBe('full')
    expect(message).toMatch(/full/i)
    expect(message).toContain(PATH)
  })

  it.each(['ENOENT', 'ENOTDIR', 'EROFS'])('%s classifies as "unavailable"', (code) => {
    const { category, message } = classifyStorageError(errnoError(code), PATH)
    expect(category).toBe('unavailable')
    expect(message).toMatch(/unavailable/i)
    expect(message).toContain(PATH)
  })

  it('an unrecognized code classifies as "generic"', () => {
    const { category, message } = classifyStorageError(errnoError('EMFILE'), PATH)
    expect(category).toBe('generic')
    expect(message).toContain(PATH)
  })

  it('a non-errno error (no .code) classifies as "generic"', () => {
    const { category } = classifyStorageError(new Error('mystery failure'), PATH)
    expect(category).toBe('generic')
  })

  it('never leaks the raw underlying error message into the sanitized message', () => {
    const secretish = errnoError('EACCES')
    secretish.message = 'postgresql://user:hunter2@db:5432/vault OPENED_BY_SECRET_TOKEN_abc123'
    const { message } = classifyStorageError(secretish, PATH)
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('OPENED_BY_SECRET_TOKEN_abc123')
  })

  it('stable category strings are consistent across calls for the same code', () => {
    const first = classifyStorageError(errnoError('EACCES'), PATH)
    const second = classifyStorageError(errnoError('EACCES'), PATH)
    expect(first.category).toBe(second.category)
    expect(first.message).toBe(second.message)
  })
})
