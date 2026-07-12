import { describe, expect, it } from 'vitest'
import type { AccessReportUser } from './access-report-schema.js'
import { buildAccessReportCsv, paginateAccessReportUsers } from './access-report.js'

function user(overrides: Partial<AccessReportUser> = {}): AccessReportUser {
  return {
    userId: 'user-1',
    displayName: 'Alice',
    orgRole: 'member',
    status: 'active',
    projects: [],
    ...overrides,
  }
}

describe('paginateAccessReportUsers', () => {
  const users = Array.from({ length: 5 }, (_, i) => user({ userId: `user-${i}` }))

  it('returns the first page and reports hasNext=true when more remain', () => {
    const result = paginateAccessReportUsers(users, 1, 2)
    expect(result.pageUsers.map((u) => u.userId)).toEqual(['user-0', 'user-1'])
    expect(result.total).toBe(5)
    expect(result.hasNext).toBe(true)
  })

  it('returns the last page and reports hasNext=false when nothing remains', () => {
    const result = paginateAccessReportUsers(users, 3, 2)
    expect(result.pageUsers.map((u) => u.userId)).toEqual(['user-4'])
    expect(result.hasNext).toBe(false)
  })

  it('returns an empty page (not an error) when the page is beyond available data', () => {
    const result = paginateAccessReportUsers(users, 100, 20)
    expect(result.pageUsers).toEqual([])
    expect(result.total).toBe(5)
    expect(result.hasNext).toBe(false)
  })
})

describe('buildAccessReportCsv', () => {
  it('includes the header row and one row per user with zero projects', () => {
    const csv = buildAccessReportCsv([user({ userId: 'solo' })])
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('user_id,display_name,org_role,status,project_id,project_role,granted_at')
    expect(lines[1]).toBe('solo,Alice,member,active,,,')
  })

  it('emits one row per (user x project) pair for a user with multiple projects', () => {
    const csv = buildAccessReportCsv([
      user({
        userId: 'multi',
        projects: [
          {
            projectId: 'p1',
            projectName: 'P1',
            role: 'member',
            grantedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            projectId: 'p2',
            projectName: 'P2',
            role: 'admin',
            grantedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    ])
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(3) // header + 2 project rows
    expect(lines[1]).toContain('p1,member')
    expect(lines[2]).toContain('p2,admin')
  })
})
