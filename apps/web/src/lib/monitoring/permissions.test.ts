import { describe, expect, it } from 'vitest'
import { canDismissAlert, canManageMonitoredAssets } from './permissions.js'

describe('canManageMonitoredAssets (AC-I1: member+ can create/edit/delete/snooze)', () => {
  it('allows member, admin, owner', () => {
    expect(canManageMonitoredAssets('member')).toBe(true)
    expect(canManageMonitoredAssets('admin')).toBe(true)
    expect(canManageMonitoredAssets('owner')).toBe(true)
  })

  it('denies viewer', () => {
    expect(canManageMonitoredAssets('viewer')).toBe(false)
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
