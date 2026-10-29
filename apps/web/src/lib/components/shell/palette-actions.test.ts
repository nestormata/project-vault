import { describe, expect, it } from 'vitest'
import { asOrgRole, filterActions, projectActions, staticActions } from './palette-actions.js'

describe('palette actions (authorization first)', () => {
  it('owner sees Create project and Go to Audit log', () => {
    expect(staticActions('owner').map((a) => a.label)).toEqual([
      'Create project',
      'Go to Audit log',
    ])
  })

  it('admin and member create projects but cannot open the audit log', () => {
    for (const role of ['admin', 'member'] as const) {
      expect(staticActions(role).map((a) => a.label)).toEqual(['Create project'])
    }
  })

  it('a viewer and an unknown role get no static action at all', () => {
    expect(staticActions('viewer')).toEqual([])
    expect(staticActions(asOrgRole('superuser'))).toEqual([])
    expect(staticActions(asOrgRole(undefined))).toEqual([])
  })

  it('New secret in X needs a creator org role and a member+ project role', () => {
    const project = { id: 'p1', name: 'Payments', role: 'member' }
    expect(projectActions('member', [project]).map((a) => a.label)).toEqual([
      'New secret in Payments',
    ])
    expect(projectActions('member', [{ ...project, role: 'viewer' }])).toEqual([])
    expect(projectActions('viewer', [project])).toEqual([])
    expect(projectActions(null, [project])).toEqual([])
    // an org owner keeps the owner role whatever the project row says
    expect(projectActions('owner', [{ ...project, role: 'viewer' }])).toHaveLength(1)
  })

  it('an archived project offers no New secret action', () => {
    expect(
      projectActions('owner', [{ id: 'p', name: 'Old', role: 'owner', isArchived: true }])
    ).toEqual([])
  })

  it('targets carry the project id', () => {
    const [action] = projectActions('admin', [{ id: 'p9', name: 'X', role: 'admin' }])
    expect(action?.target).toEqual({ to: 'new-secret', projectId: 'p9' })
  })

  it('filters by a case-insensitive substring; empty keeps all', () => {
    const all = staticActions('owner')
    expect(filterActions(all, '')).toHaveLength(2)
    expect(filterActions(all, '  AUDIT ').map((a) => a.id)).toEqual(['go-audit-log'])
    expect(filterActions(all, 'zzz')).toEqual([])
  })
})
