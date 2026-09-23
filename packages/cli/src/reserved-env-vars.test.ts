import { describe, expect, it } from 'vitest'
import {
  RESERVED_ENV_VAR_NAMES,
  isReservedEnvVarName,
  isValidEnvVarIdentifier,
} from './reserved-env-vars.js'

describe('RESERVED_ENV_VAR_NAMES', () => {
  it('is the exact set ported from packages/vault-action, minus the two GitHub-Actions-only entries', () => {
    expect([...RESERVED_ENV_VAR_NAMES].sort()).toEqual(
      [
        'PATH',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
        'NODE_OPTIONS',
        'HOME',
        'SHELL',
      ].sort()
    )
  })

  it('does not include the two GitHub-Actions-specific entries dropped for a terminal context', () => {
    expect(isReservedEnvVarName('GITHUB_TOKEN')).toBe(false)
    expect(isReservedEnvVarName('GITHUB_ANYTHING')).toBe(false)
    expect(isReservedEnvVarName('ACTIONS_ANYTHING')).toBe(false)
  })
})

describe('isReservedEnvVarName', () => {
  it.each([...RESERVED_ENV_VAR_NAMES])('flags %s as reserved', (name) => {
    expect(isReservedEnvVarName(name)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isReservedEnvVarName('ld_preload')).toBe(true)
    expect(isReservedEnvVarName('Path')).toBe(true)
  })

  it('does not flag an ordinary env var name', () => {
    expect(isReservedEnvVarName('DATABASE_URL')).toBe(false)
  })
})

describe('isValidEnvVarIdentifier', () => {
  it('accepts a normal identifier', () => {
    expect(isValidEnvVarIdentifier('DATABASE_URL')).toBe(true)
    expect(isValidEnvVarIdentifier('_FOO')).toBe(true)
  })

  it('rejects a free-form credential name shape', () => {
    expect(isValidEnvVarIdentifier('my-db-password')).toBe(false)
    expect(isValidEnvVarIdentifier('my db password')).toBe(false)
    expect(isValidEnvVarIdentifier('1LEADING_DIGIT')).toBe(false)
    expect(isValidEnvVarIdentifier('')).toBe(false)
  })
})
