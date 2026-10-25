import { describe, expect, it } from 'vitest'
import { canDismissAlert, canManageMonitoredAssets } from './permissions.js'

const asMember = { role: 'member' }
const asViewer = { role: 'viewer' }

describe('canManageMonitoredAssets (AC-I1: member+ can create/edit/delete/snooze)', () => {
  it('allows member, admin, owner with a writing project role', () => {
    expect(canManageMonitoredAssets({ orgRole: 'member', project: asMember })).toBe(true)
    expect(canManageMonitoredAssets({ orgRole: 'admin', project: asMember })).toBe(true)
    expect(canManageMonitoredAssets({ orgRole: 'owner', project: asMember })).toBe(true)
  })

  it('denies an org viewer', () => {
    expect(canManageMonitoredAssets({ orgRole: 'viewer', project: asMember })).toBe(false)
  })

  it('denies a project viewer whose org role is member (Story 69.17, DW-606)', () => {
    expect(canManageMonitoredAssets({ orgRole: 'member', project: asViewer })).toBe(false)
  })

  it('keeps the org admin bypass over a viewer row', () => {
    expect(canManageMonitoredAssets({ orgRole: 'admin', project: asViewer })).toBe(true)
  })
})

describe('canDismissAlert (Background/ADR-6.2-04: dismiss requires admin+, not member+)', () => {
  it('allows admin and owner', () => {
    expect(canDismissAlert('admin')).toBe(true)
    expect(canDismissAlert('owner')).toBe(true)
  })

  it('denies member and viewer', () => {
    expect(canDismissAlert('member')).toBe(false)
    expect(canDismissAlert('viewer')).toBe(false)
  })
})
