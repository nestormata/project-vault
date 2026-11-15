import { describe, expect, it } from 'vitest'
import { isKnownOrgRole } from './org-roles.js'

describe('isKnownOrgRole (Story 73.5 D7)', () => {
  it('accepts the four stored org roles', () => {
    expect(isKnownOrgRole('owner')).toBe(true)
    expect(isKnownOrgRole('admin')).toBe(true)
    expect(isKnownOrgRole('member')).toBe(true)
    expect(isKnownOrgRole('viewer')).toBe(true)
  })

  it('rejects an unrecognized stored value', () => {
    expect(isKnownOrgRole('superuser')).toBe(false)
    expect(isKnownOrgRole('')).toBe(false)
    expect(isKnownOrgRole('OWNER')).toBe(false)
  })
})
