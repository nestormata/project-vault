import { describe, expect, it } from 'vitest'
import { projectMemberships, projects } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('projects schema', () => {
  it('exposes org-scoped projects columns', () => {
    expect(projects.id).toBeDefined()
    expect(projects.orgId).toBeDefined()
    expect(projects.name).toBeDefined()
    expect(projects.slug).toBeDefined()
    expect(projects.description).toBeDefined()
    expect(projects.tags).toBeDefined()
    expect(projects.createdBy).toBeDefined()
    expect(projects.createdAt).toBeDefined()
    expect(projects.updatedAt).toBeDefined()
    expect(projects.archivedAt).toBeDefined()
  })

  it('exposes org-scoped project membership columns', () => {
    expect(projectMemberships.orgId).toBeDefined()
    expect(projectMemberships.projectId).toBeDefined()
    expect(projectMemberships.userId).toBeDefined()
    expect(projectMemberships.role).toBeDefined()
    expect(projectMemberships.createdAt).toBeDefined()
  })

  it('keeps project tables subject to RLS coverage', () => {
    expect(EXCLUDED_TABLES.has('projects')).toBe(false)
    expect(EXCLUDED_TABLES.has('project_memberships')).toBe(false)
  })
})
