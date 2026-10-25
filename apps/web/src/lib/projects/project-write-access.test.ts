import { describe, expect, it } from 'vitest'
import { canWriteInProject, effectiveProjectRole } from './project-write-access.js'

describe('effectiveProjectRole (Story 69.17)', () => {
  it.each([
    ['owner', 'viewer', 'owner'],
    ['admin', 'viewer', 'admin'],
    ['member', 'viewer', 'viewer'],
    ['member', 'admin', 'admin'],
    ['viewer', 'member', 'member'],
    ['member', 'member', 'member'],
  ] as const)('org %s with project role %s resolves to %s', (orgRole, projectRole, expected) => {
    expect(effectiveProjectRole(orgRole, { role: projectRole })).toBe(expected)
  })

  it('a missing project resolves to viewer for a non-admin', () => {
    expect(effectiveProjectRole('member', null)).toBe('viewer')
    expect(effectiveProjectRole('member', undefined)).toBe('viewer')
  })

  it('a project without a recognized role falls back to the org role, as the API does', () => {
    expect(effectiveProjectRole('member', { role: 'superuser' })).toBe('member')
    expect(effectiveProjectRole('viewer', { role: null })).toBe('viewer')
  })

  it('an org admin keeps the bypass even without a project', () => {
    expect(effectiveProjectRole('admin', null)).toBe('admin')
  })
})

describe('canWriteInProject (Story 69.17)', () => {
  it('refuses a project viewer whatever their org role below admin', () => {
    expect(canWriteInProject('member', { role: 'viewer' })).toBe(false)
    expect(canWriteInProject('viewer', { role: 'viewer' })).toBe(false)
  })

  it('allows project member, admin and owner, and org admin/owner over a viewer row', () => {
    expect(canWriteInProject('member', { role: 'member' })).toBe(true)
    expect(canWriteInProject('member', { role: 'admin' })).toBe(true)
    expect(canWriteInProject('member', { role: 'owner' })).toBe(true)
    expect(canWriteInProject('admin', { role: 'viewer' })).toBe(true)
    expect(canWriteInProject('owner', { role: 'viewer' })).toBe(true)
  })

  it('hides writes when the project is not loaded', () => {
    expect(canWriteInProject('member', null)).toBe(false)
  })
})
