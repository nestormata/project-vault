import { describe, expect, it } from 'vitest'
import { getProjectNavItems, isActiveProjectNavItem, projectNavHref } from './project-nav-model.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('project-nav-model', () => {
  it('AC-8: lists all 9 tabs in order for a non-viewer role', () => {
    const items = getProjectNavItems(projectId, 'member')
    expect(items.map((item) => item.label)).toEqual([
      'Overview',
      'Credentials',
      'Members',
      'Machine Users',
      'Services',
      'Certificates',
      'Domains',
      'Endpoints',
      'Status Page',
    ])
    expect(items[0]?.href).toBe(`/projects/${projectId}`)
    expect(items[1]?.href).toBe(`/projects/${projectId}/credentials`)
  })

  it('AC-9: hides the Endpoints tab for a viewer role (its list endpoint 403s org-viewers)', () => {
    const items = getProjectNavItems(projectId, 'viewer')
    expect(items.map((item) => item.label)).not.toContain('Endpoints')
    expect(items).toHaveLength(8)
  })

  it('AC-9: keeps every tab for owner/admin/member roles', () => {
    for (const role of ['owner', 'admin', 'member']) {
      expect(getProjectNavItems(projectId, role)).toHaveLength(9)
    }
  })

  it('projectNavHref builds the overview href with no suffix', () => {
    expect(projectNavHref(projectId, '')).toBe(`/projects/${projectId}`)
    expect(projectNavHref(projectId, 'members')).toBe(`/projects/${projectId}/members`)
  })

  it('AC-9: Overview matches only the exact overview path, not deeper project screens', () => {
    const [overview] = getProjectNavItems(projectId, 'member')
    if (!overview) throw new Error('expected an overview item')
    expect(isActiveProjectNavItem(overview, `/projects/${projectId}`)).toBe(true)
    expect(isActiveProjectNavItem(overview, `/projects/${projectId}/credentials`)).toBe(false)
  })

  it('AC-9: non-overview tabs match nested detail routes via prefix (mirrors isActiveNavItem)', () => {
    const items = getProjectNavItems(projectId, 'member')
    const credentials = items.find((item) => item.label === 'Credentials')
    if (!credentials) throw new Error('expected a credentials item')
    expect(isActiveProjectNavItem(credentials, `/projects/${projectId}/credentials`)).toBe(true)
    expect(isActiveProjectNavItem(credentials, `/projects/${projectId}/credentials/some-id`)).toBe(
      true
    )
    expect(isActiveProjectNavItem(credentials, `/projects/${projectId}/members`)).toBe(false)
  })
})
