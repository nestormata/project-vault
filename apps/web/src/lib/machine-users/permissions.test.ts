import { describe, expect, it } from 'vitest'
import { canManageMachineUsers } from './permissions.js'

describe('machine-user permissions (UX-only mirror of server minimumRole: admin gate)', () => {
  it('is true only for admin/owner', () => {
    expect(canManageMachineUsers('owner')).toBe(true)
    expect(canManageMachineUsers('admin')).toBe(true)
    expect(canManageMachineUsers('member')).toBe(false)
    expect(canManageMachineUsers('viewer')).toBe(false)
  })
})
