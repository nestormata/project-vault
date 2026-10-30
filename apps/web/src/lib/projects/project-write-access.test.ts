import { describe, expect, it } from 'vitest'
import {
  canArchiveInProject,
  canEditProject,
  canWriteInProject,
  effectiveProjectRole,
} from './project-write-access.js'

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

// DW-606 follow-up: the whole matrix of the API's effective-role rule (org owner/admin bypass; else
// the project membership role; else the org role). The project payload's `role` already folds the
// "no row" fallback in (membership role ?? org role), so "no row" is `{ role: <org role> }`.
describe('canWriteInProject matrix (mirrors apps/api effectiveProjectRoleForCaller)', () => {
  it.each([
    ['org owner, viewer row', 'owner', { role: 'viewer' }, true],
    ['org owner, no row', 'owner', { role: 'owner' }, true],
    ['org admin, viewer row', 'admin', { role: 'viewer' }, true],
    ['org admin, no row', 'admin', { role: 'admin' }, true],
    ['org member, viewer row', 'member', { role: 'viewer' }, false],
    ['org member, member row', 'member', { role: 'member' }, true],
    ['org member, owner row', 'member', { role: 'owner' }, true],
    ['org member, no row', 'member', { role: 'member' }, true],
    ['org viewer, no row', 'viewer', { role: 'viewer' }, false],
    ['org viewer, member row', 'viewer', { role: 'member' }, true],
    ['org member, project not loaded', 'member', null, false],
  ] as const)('%s', (_label, orgRole, project, expected) => {
    expect(canWriteInProject(orgRole, project)).toBe(expected)
  })
})

describe('canArchiveInProject (Story 69.20, DW-618)', () => {
  it.each([
    ['member', 'owner', true],
    ['admin', 'owner', true],
    ['owner', 'member', true],
    ['owner', 'viewer', true],
    ['admin', 'admin', false],
    ['admin', 'member', false],
    ['member', 'admin', false],
    ['member', 'member', false],
    ['member', 'viewer', false],
    ['viewer', 'owner', false],
  ] as const)('org %s with project role %s -> %s', (orgRole, projectRole, expected) => {
    expect(canArchiveInProject(orgRole, { role: projectRole })).toBe(expected)
  })

  it('hides the control without a project or an org role', () => {
    expect(canArchiveInProject('owner', null)).toBe(false)
    expect(canArchiveInProject('owner', undefined)).toBe(false)
    expect(canArchiveInProject(undefined, { role: 'owner' })).toBe(false)
  })
})

describe('canEditProject (Story 72-9)', () => {
  it.each([
    ['member', 'owner', true],
    ['admin', 'owner', true],
    ['owner', 'member', true],
    ['admin', 'admin', true],
    ['admin', 'member', true],
    ['admin', 'viewer', true],
    ['member', 'admin', false],
    ['member', 'member', false],
    ['member', 'viewer', false],
    ['viewer', 'viewer', false],
    ['viewer', 'owner', false],
  ] as const)('org %s with project role %s -> %s', (orgRole, projectRole, expected) => {
    expect(canEditProject(orgRole, { role: projectRole })).toBe(expected)
  })

  it('hides the form without a project or an org role', () => {
    expect(canEditProject('admin', null)).toBe(false)
    expect(canEditProject(undefined, { role: 'owner' })).toBe(false)
  })
})
