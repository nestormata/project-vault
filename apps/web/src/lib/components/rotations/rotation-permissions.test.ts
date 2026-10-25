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
    const asMember = { role: 'member' }
    expect(canActOnChecklist('owner', asMember)).toBe(true)
    expect(canActOnChecklist('admin', asMember)).toBe(true)
    expect(canActOnChecklist('member', asMember)).toBe(true)
    expect(canActOnChecklist('viewer', asMember)).toBe(false)
  })

  it('canActOnChecklist is false for a project viewer (Story 69.17, DW-606)', () => {
    expect(canActOnChecklist('member', { role: 'viewer' })).toBe(false)
    expect(canActOnChecklist('admin', { role: 'viewer' })).toBe(true)
  })
})
