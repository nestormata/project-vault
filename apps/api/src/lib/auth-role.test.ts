import { describe, expect, it } from 'vitest'
import { AppError } from './errors.js'
import { orgRoleOrDeny } from './auth-role.js'

describe('orgRoleOrDeny (Story 71.3)', () => {
  it('returns the role of a context that has one', () => {
    expect(orgRoleOrDeny({ orgRole: 'admin' })).toBe('admin')
    expect(orgRoleOrDeny({ orgRole: 'viewer' })).toBe('viewer')
  })

  it('answers 403 insufficient_role for a context with no role (no role = no access)', () => {
    let caught: unknown
    try {
      orgRoleOrDeny({})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppError)
    expect(caught).toMatchObject({ code: 'insufficient_role', statusCode: 403 })
  })
})
