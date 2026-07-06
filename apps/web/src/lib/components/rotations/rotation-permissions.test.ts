import { describe, expect, it } from 'vitest'
import { canActOnChecklist, canManageRotations } from './rotation-permissions.js'

describe('rotation permissions (UX-only mirror of server-side role gates)', () => {
  it('canManageRotations is true only for admin/owner (initiate/complete/break-glass/resume/abandon)', () => {
    expect(canManageRotations('owner')).toBe(true)
    expect(canManageRotations('admin')).toBe(true)
    expect(canManageRotations('member')).toBe(false)
    expect(canManageRotations('viewer')).toBe(false)
  })

  it('canActOnChecklist is true for member and above (confirm/fail/retry)', () => {
    expect(canActOnChecklist('owner')).toBe(true)
    expect(canActOnChecklist('admin')).toBe(true)
    expect(canActOnChecklist('member')).toBe(true)
    expect(canActOnChecklist('viewer')).toBe(false)
  })
})
